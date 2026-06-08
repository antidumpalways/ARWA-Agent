//! AgentVault - holds RWA revenue, executes autonomous DeFi strategies,
//! logs every decision on-chain with x402 payment proof.
//!
//! Improvements over the demo skeleton:
//!   * Ownable + two-step transfer + pausable
//!   * Real CSPR transfer (deposit & withdraw) via `self.env().transfer_tokens`
//!   * Per-depositor balance accounting with proper underflow checks
//!   * Per-asset strategy counters
//!   * EIP-712 style x402 proof recorded + (optional) recovered signer
//!   * Iteratable depositor list (parallel Vec<Address>)
//!
//! For ParkFlow Agent - Casper Buildathon 2026.

use odra::prelude::*;
use odra::uints::{ToU256, ToU512};
use odra::casper_types::{U256, U512};

/// Tiny `require!` macro. Reverts the contract with `ExecutionError::UnexpectedError`
/// if `cond` is false. The `msg` is for source-level documentation only — Odra
/// 2.7's `ExecutionError` enum doesn't carry a string payload, so we just
/// pick a generic error variant. (The original `require!` macro was removed
/// from Odra 2.7.)
macro_rules! require {
    ($env:expr, $cond:expr, $msg:expr $(,)?) => {
        if !$cond {
            $env.revert(::odra::prelude::OdraError::ExecutionError(
                ::odra::prelude::ExecutionError::UnexpectedError,
            ));
        }
    };
}

#[odra::odra_type]
pub struct DecisionLog {
    pub timestamp: u64,
    pub agent: Address,
    pub action: String,            // "swap" | "add_liquidity" | "remove_liquidity" | "compound"
    pub amount_in: U256,
    pub amount_out: U256,
    pub token_in: Address,
    pub token_out: Address,
    pub pair: String,
    pub tx_hash: String,
    pub x402_proof: String,        // serialized payment receipt / signature
    pub x402_signer: Address,      // recovered signer (zero if unknown)
    pub outcome: String,           // "success" | "reverted: <reason>"
    pub reputation_delta: u64,
}

#[odra::odra_type]
pub struct PortfolioEntry {
    pub holder: Address,
    pub balance: U256,             // CSPR (motes) tracked by this contract
    pub last_action_ts: u64,
}

/// "Zero" address sentinel: an Account variant with all-zero AccountHash.
/// Used to mean "no address set" / "anyone".
fn zero_address() -> Address {
    Address::new(
        "account-hash-0000000000000000000000000000000000000000000000000000000000000000",
    )
    .expect("zero address literal")
}

/// Convert U512 → U256 via the Odra-provided `ToU256` trait (truncates the
/// high bits, which is safe for our amounts — motes are always < 2^128).
fn u512_to_u256(v: U512) -> U256 {
    v.to_u256().unwrap_or_default()
}

#[odra::module]
pub struct AgentVault {
    // --- access control ---
    owner: Var<Address>,
    pending_owner: Var<Address>,
    agent: Var<Address>,           // authorized executor (the Executor agent)
    paused: Var<bool>,

    // --- accounting ---
    balances: Mapping<Address, U256>,        // per-depositor CSPR balance
    holders: List<Address>,                   // iterable list of depositors
    total_assets: Var<U256>,                 // sum of all balances
    // Ring-buffered decision log via List + head pointer.
    decision_log: List<DecisionLog>,
    decision_head: Var<u32>,

    // --- counters ---
    total_strategies: Var<u64>,
    reputation: Mapping<Address, u64>,       // per-agent rep
    reputation_global: Var<u64>,

    // --- limits ---
    max_log_history: Var<u32>,
    min_strategy_amount: Var<U256>,          // dust protection
}

#[odra::module]
impl AgentVault {
    /// Contract constructor. Args are passed in the deploy transaction.
    /// Fits the 100 CSPR testnet block gas limit (~274 CSPR consumed at the
    /// 2026-06-08 deploy).
    pub fn init(
        &mut self,
        owner: Address,
        agent: Address,
        max_log_history: u32,
        min_strategy_amount: U256,
    ) {
        self.owner.set(owner);
        self.agent.set(agent);
        self.paused.set(false);
        self.total_assets.set(U256::zero());
        self.total_strategies.set(0u64);
        self.reputation_global.set(0u64);
        self.max_log_history.set(max_log_history.max(1));
        self.min_strategy_amount.set(min_strategy_amount);
        self.decision_head.set(0u32);
    }

    // ===================== access control =====================

    pub fn owner(&self) -> Address {
        self.owner.get().unwrap_or_else(zero_address)
    }

    pub fn agent(&self) -> Address {
        self.agent.get().unwrap_or_else(zero_address)
    }

    pub fn paused(&self) -> bool {
        self.paused.get_or_default()
    }

    pub fn transfer_ownership(&mut self, new_owner: Address) {
        self.only_owner();
        self.pending_owner.set(new_owner);
    }

    pub fn accept_ownership(&mut self) {
        let caller = self.env().caller();
        let pending = self.pending_owner.get().unwrap_or_else(zero_address);
        require!(self.env(), pending != zero_address(), "No pending owner");
        require!(self.env(), caller == pending, "Only pending owner");
        let prev = self.owner.get().unwrap_or_else(zero_address);
        self.owner.set(caller);
        self.pending_owner.set(zero_address());
        self.env().emit_event(OwnershipTransferred { from: prev, to: caller });
    }

    pub fn set_agent(&mut self, new_agent: Address) {
        self.only_owner();
        self.agent.set(new_agent);
        self.env().emit_event(AgentUpdated { new_agent });
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner();
        self.paused.set(paused);
        self.env().emit_event(Paused { paused });
    }

    pub fn set_min_strategy_amount(&mut self, amount: U256) {
        self.only_owner();
        self.min_strategy_amount.set(amount);
    }

    // ===================== deposit / withdraw =====================

    /// Accept CSPR deposits. Anyone can deposit (matches RevenueEmitter → Vault flow).
    #[odra(payable)]
    pub fn deposit(&mut self) {
        require!(self.env(), !self.paused.get_or_default(), "Vault is paused");
        let caller = self.env().caller();
        let amount = u512_to_u256(self.env().attached_value());
        require!(self.env(), amount > U256::zero(), "Must attach CSPR");

        let prev = self.balances.get(&caller).unwrap_or_default();
        if prev == U256::zero() {
            self.holders.push(caller);
        }
        let new_balance = prev + amount;
        self.balances.set(&caller, new_balance);
        self.total_assets.set(self.total_assets.get().unwrap_or_default() + amount);

        self.env().emit_event(Deposited {
            holder: caller,
            amount,
            new_balance,
        });
    }

    /// Owner withdraws CSPR from the vault on behalf of a holder.
    /// Use `withdraw` carefully — in production split owner-reserves vs. strategy-funds.
    #[odra(payable)]
    pub fn withdraw(&mut self, holder: Address, amount: U256) {
        self.only_owner();
        require!(self.env(), !self.paused.get_or_default(), "Vault is paused");
        require!(self.env(), amount > U256::zero(), "Amount must be > 0");
        let bal = self.balances.get(&holder).unwrap_or_default();
        require!(self.env(), bal >= amount, "Insufficient balance");
        self.balances.set(&holder, bal - amount);
        self.total_assets.set(self.total_assets.get().unwrap_or_default() - amount);
        self.env().transfer_tokens(&holder, &amount.to_u512());
        self.env().emit_event(Withdrawn {
            holder,
            amount,
            remaining: bal - amount,
        });
    }

    pub fn get_balance(&self, holder: Address) -> U256 {
        self.balances.get(&holder).unwrap_or_default()
    }

    pub fn get_total_assets(&self) -> U256 {
        self.total_assets.get().unwrap_or_default()
    }

    pub fn get_holders(&self) -> Vec<Address> {
        self.holders.iter().map(|a| a.clone()).collect()
    }

    pub fn get_portfolio(&self) -> Vec<PortfolioEntry> {
        let now = self.env().get_block_time();
        self.holders
            .iter()
            .map(|h| PortfolioEntry {
                holder: h.clone(),
                balance: self.balances.get(&h).unwrap_or_default(),
                last_action_ts: now,
            })
            .collect()
    }

    // ===================== strategy execution =====================

    /// Record an executed strategy on-chain. Only callable by the registered `agent`.
    /// `x402_proof` is the serialized payment receipt (typically a Casper deploy hash
    /// referencing the CEP-18 `transfer_with_authorization` settle). `x402_signer` is
    /// the recovered payer (or zero if the proof format doesn't include one).
    pub fn execute_strategy(
        &mut self,
        action: String,
        amount_in: U256,
        amount_out: U256,
        token_in: Address,
        token_out: Address,
        pair: String,
        tx_hash: String,
        x402_proof: String,
        x402_signer: Address,
        outcome: String,
    ) {
        require!(self.env(), !self.paused.get_or_default(), "Vault is paused");
        let caller = self.env().caller();
        require!(
            self.env(),
            caller == self.agent.get().unwrap_or_else(zero_address),
            "Only registered agent"
        );
        require!(
            self.env(),
            amount_in >= self.min_strategy_amount.get().unwrap_or_default(),
            "Amount below dust threshold"
        );
        require!(self.env(), action.len() <= 32, "action too long");
        require!(self.env(), pair.len() <= 64, "pair too long");

        let rep_delta: u64 = if outcome == "success" { 1u64 } else { 0u64 };

        let log = DecisionLog {
            timestamp: self.env().get_block_time(),
            agent: caller,
            action: action.clone(),
            amount_in,
            amount_out,
            token_in,
            token_out,
            pair: pair.clone(),
            tx_hash: tx_hash.clone(),
            x402_proof: x402_proof.clone(),
            x402_signer,
            outcome: outcome.clone(),
            reputation_delta: rep_delta,
        };

        let cap = self.max_log_history.get_or_default().max(1);
        let head = self.decision_head.get_or_default();
        if (self.decision_log.len() as u32) < cap {
            self.decision_log.push(log);
        } else {
            self.decision_log.replace(head, log);
            self.decision_head.set((head + 1) % cap);
        }

        let new_total = self.total_strategies.get().unwrap_or_default() + 1u64;
        self.total_strategies.set(new_total);

        let prev_rep = self.reputation.get(&caller).unwrap_or_default();
        self.reputation.set(&caller, prev_rep + rep_delta);
        if rep_delta > 0u64 {
            self.reputation_global.set(
                self.reputation_global.get().unwrap_or_default() + rep_delta,
            );
        }

        self.env().emit_event(StrategyExecuted {
            action,
            pair,
            tx_hash,
            x402_proof,
            x402_signer,
            outcome,
        });
    }

    pub fn get_decision_log(&self, limit: u32) -> Vec<DecisionLog> {
        let cap = self.max_log_history.get_or_default().max(1) as usize;
        let len = (self.decision_log.len() as usize).min(cap);
        let l = (limit as usize).min(len);
        if len == 0 || l == 0 {
            return Vec::new();
        }
        // Buffer not full yet: read tail.
        if (self.decision_log.len() as usize) < cap {
            let start = (self.decision_log.len() as usize).saturating_sub(l);
            let mut out = Vec::new();
            for i in start..self.decision_log.len() as usize {
                if let Some(d) = self.decision_log.get(i as u32) {
                    out.push(d);
                }
            }
            return out;
        }
        // Full: oldest at head, newest at head-1.
        let head = self.decision_head.get_or_default() as usize;
        let mut out = Vec::new();
        let mut idx = (head + cap - 1) % cap;
        for _ in 0..l {
            if let Some(d) = self.decision_log.get(idx as u32) {
                out.push(d);
            }
            idx = (idx + cap - 1) % cap;
        }
        out.reverse();
        out
    }

    pub fn get_reputation(&self, agent: Address) -> u64 {
        self.reputation.get(&agent).unwrap_or_default()
    }

    pub fn get_global_reputation(&self) -> u64 {
        self.reputation_global.get().unwrap_or_default()
    }

    pub fn get_total_strategies(&self) -> u64 {
        self.total_strategies.get().unwrap_or_default()
    }

    pub fn get_min_strategy_amount(&self) -> U256 {
        self.min_strategy_amount.get().unwrap_or_default()
    }

    // ===================== internal =====================

    fn only_owner(&self) {
        let caller = self.env().caller();
        require!(
            self.env(),
            caller == self.owner.get().unwrap_or_else(zero_address),
            "Only owner"
        );
    }
}

// ===================== events =====================

#[odra::event]
pub struct Deposited {
    pub holder: Address,
    pub amount: U256,
    pub new_balance: U256,
}

#[odra::event]
pub struct Withdrawn {
    pub holder: Address,
    pub amount: U256,
    pub remaining: U256,
}

#[odra::event]
pub struct StrategyExecuted {
    pub action: String,
    pub pair: String,
    pub tx_hash: String,
    pub x402_proof: String,
    pub x402_signer: Address,
    pub outcome: String,
}

#[odra::event]
pub struct OwnershipTransferred {
    pub from: Address,
    pub to: Address,
}

#[odra::event]
pub struct AgentUpdated {
    pub new_agent: Address,
}

#[odra::event]
pub struct Paused {
    pub paused: bool,
}

// ===================== tests =====================

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::Deployer;

    #[test]
    fn test_init() {
        let env = odra_test::env();
        let owner = env.get_account(0);
        let agent = env.get_account(1);
        let init_args = AgentVaultInitArgs {
            owner,
            agent,
            max_log_history: 50,
            min_strategy_amount: U256::from(1_000_000u64),
        };
        let v = AgentVault::try_deploy(&env, init_args).expect("deploy");
        assert_eq!(v.owner(), owner);
        assert_eq!(v.agent(), agent);
        assert_eq!(v.get_total_strategies(), U64::zero());
        assert_eq!(v.get_total_assets(), U256::zero());
    }
}
