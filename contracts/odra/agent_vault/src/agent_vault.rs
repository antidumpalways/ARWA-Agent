//! AgentVault - real fund custodian + audit log for ARWA.
//!
//! Two responsibilities:
//!   1. **Custody**: receives CSPR from the agent (on behalf of stakeholders)
//!      and tracks positions / yield. Stakeholders don't interact directly
//!      with the vault — the agent is the only authorised caller.
//!   2. **Audit log**: every strategy decision is recorded as a DecisionLog
//!      entry, callable via the existing `execute_strategy` entry point.
//!
//! Designed to coexist with StakeholderDeposit (Phase 1 of v0.8.1):
//! stakeholders call StakeholderDeposit.deposit() to record their intent,
//! then the agent moves the actual CSPR into the vault via
//! `deposit_for_strategy()`. The two contracts together implement the
//! "stakeholder → deposit → vault → agent → yield" flow.
//!
//! For Casper Agentic Buildathon 2026 - ARWA.

use odra::prelude::*;
use odra::casper_types::U256;

/// Local `require!` macro for v0.8.1 compatibility (Odra 2.7 removed the
/// built-in version). Reverts with `ExecutionError::UnexpectedError` if
/// `cond` is false. The `msg` is for source-level documentation only.
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
    pub action: String,
    pub amount_in: U256,
    pub amount_out: U256,
    pub token_in: Address,
    pub token_out: Address,
    pub pair: String,
    pub tx_hash: String,
    pub x402_proof: String,
    pub x402_signer: Address,
    pub outcome: String,
    pub reputation_delta: u64,
}

/// A single active position held by the vault on behalf of its
/// stakeholders (delegate to a validator, LP token, etc.).
#[odra::odra_type]
pub struct Position {
    pub id: u64,
    pub kind: String,                // "validator_delegate" | "lp" | "sCSPR"
    pub target: String,              // validator pubkey, pair address, etc.
    pub amount: U256,                // motes
    pub opened_ts: u64,
    pub opened_tx: String,           // tx hash that created this position
    pub realised_yield: U256,        // cumulative yield claimed from this position
    pub is_closed: bool,
    pub closed_ts: u64,
    pub closed_tx: String,
}

#[odra::module]
pub struct AgentVault {
    owner: Var<Address>,
    agents: Mapping<Address, bool>,
    paused: Var<bool>,
    decision_log: List<DecisionLog>,
    decision_head: Var<u32>,
    total_strategies: Var<u64>,
    reputation: Mapping<Address, u64>,
    reputation_global: Var<u64>,
    max_log_history: Var<u32>,
    min_strategy_amount: Var<U256>,

    // ---- Fund custodian state (v0.8.1+) ----
    // CSPR custodied by this contract (the agent moves funds here from
    // its own account or from a stakeholder).
    custodied_cspr: Var<U256>,
    // Lifetime total of CSPR custodied (for dashboard AUM metrics).
    total_custodied: Var<U256>,
    // Lifetime total of yield realised (claimed from positions).
    total_yield_realised: Var<U256>,
    // Active positions held by the vault (delegate, LP, etc.).
    positions: List<Position>,
    position_count: Var<u64>,
}

fn zero_address() -> Address {
    Address::new(
        "account-hash-0000000000000000000000000000000000000000000000000000000000000000",
    )
    .expect("zero address literal")
}

#[odra::module]
impl AgentVault {
    pub fn init(
        &mut self,
        owner: Address,
        agent: Address,
        max_log_history: u32,
        min_strategy_amount: U256,
    ) {
        self.owner.set(owner);
        self.agents.set(&owner, true);
        self.agents.set(&agent, true);
        self.paused.set(false);
        self.total_strategies.set(0u64);
        self.reputation_global.set(0u64);
        self.max_log_history.set(max_log_history.max(1));
        self.min_strategy_amount.set(min_strategy_amount);
        self.decision_head.set(0u32);
        // v0.8.1+ fund custodian state.
        self.custodied_cspr.set(U256::zero());
        self.total_custodied.set(U256::zero());
        self.total_yield_realised.set(U256::zero());
        self.position_count.set(0u64);
    }

    pub fn owner(&self) -> Address {
        self.owner.get().unwrap_or_else(zero_address)
    }

    pub fn is_agent(&self, agent: Address) -> bool {
        self.agents.get(&agent).unwrap_or(false)
    }

    pub fn register_agent(&mut self, agent: Address) {
        let caller = self.env().caller();
        if caller != self.owner.get().unwrap_or_else(zero_address) {
            self.env().revert(odra::prelude::OdraError::ExecutionError(
                odra::prelude::ExecutionError::UnexpectedError,
            ));
        }
        self.agents.set(&agent, true);
    }

    pub fn unregister_agent(&mut self, agent: Address) {
        let caller = self.env().caller();
        if caller != self.owner.get().unwrap_or_else(zero_address) {
            self.env().revert(odra::prelude::OdraError::ExecutionError(
                odra::prelude::ExecutionError::UnexpectedError,
            ));
        }
        self.agents.set(&agent, false);
    }

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
        let caller = self.env().caller();
        let is_auth = self.agents.get(&caller).unwrap_or(false);
        if !is_auth {
            self.env().revert(odra::prelude::OdraError::ExecutionError(
                odra::prelude::ExecutionError::UnexpectedError,
            ));
        }
        let min_amount = self.min_strategy_amount.get_or_default();
        if amount_in < min_amount {
            self.env().revert(odra::prelude::OdraError::ExecutionError(
                odra::prelude::ExecutionError::UnexpectedError,
            ));
        }
        let rep_delta: u64 = if outcome == "success" { 1u64 } else { 0u64 };
        let log = DecisionLog {
            timestamp: self.env().get_block_time(),
            agent: caller,
            action,
            amount_in,
            amount_out,
            token_in,
            token_out,
            pair,
            tx_hash,
            x402_proof,
            x402_signer,
            outcome,
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
        let new_total = self.total_strategies.get_or_default() + 1u64;
        self.total_strategies.set(new_total);
        let prev_rep = self.reputation.get(&caller).unwrap_or_default();
        self.reputation.set(&caller, prev_rep + rep_delta);
        if rep_delta > 0u64 {
            self.reputation_global.set(
                self.reputation_global.get_or_default() + rep_delta,
            );
        }
    }

    pub fn get_reputation(&self, agent: Address) -> u64 {
        self.reputation.get(&agent).unwrap_or_default()
    }

    pub fn get_global_reputation(&self) -> u64 {
        self.reputation_global.get_or_default()
    }

    pub fn get_total_strategies(&self) -> u64 {
        self.total_strategies.get_or_default()
    }

    pub fn get_decision_log(&self, limit: u32) -> Vec<DecisionLog> {
        let cap = self.max_log_history.get_or_default().max(1) as usize;
        let len = (self.decision_log.len() as usize).min(cap);
        let l = (limit as usize).min(len);
        if len == 0 || l == 0 {
            return Vec::new();
        }
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

    // -------- v0.8.1+: Fund custodian methods --------

    /// Record that the agent has moved `amount` CSPR into the vault for
    /// active management on behalf of one or more stakeholders.
    /// Callable only by an authorised agent. The CSPR transfer itself is
    /// performed by the agent in a separate native transfer tx (because
    /// Casper 2.0 ContractCall `attached_value` is not reliably supported
    /// via the JS SDK); this entry point just updates the on-chain
    /// accounting to match.
    pub fn deposit_for_strategy(
        &mut self,
        amount: U256,
        source: String,
    ) {
        let caller = self.env().caller();
        let is_agent = self.agents.get(&caller).unwrap_or(false);
        require!(
            self.env(),
            is_agent,
            "Only authorised agents can deposit_for_strategy"
        );
        require!(self.env(), amount > U256::zero(), "amount must be > 0");
        require!(self.env(), source.len() <= 64, "source too long");

        self.custodied_cspr.set(
            self.custodied_cspr.get_or_default() + amount
        );
        self.total_custodied.set(
            self.total_custodied.get_or_default() + amount
        );
        self.env().emit_event(VaultDeposit {
            amount,
            agent: caller,
            source,
            new_custodied: self.custodied_cspr.get_or_default(),
        });
    }

    /// Record a new active position. Called by the agent AFTER executing
    /// the strategy tx (delegate/LP/etc.). This is the on-chain trail of
    /// what the agent did with the custodied CSPR.
    pub fn record_strategy_execution(
        &mut self,
        kind: String,            // "validator_delegate" | "lp" | "sCSPR_swap"
        target: String,          // validator pubkey hex | pair address | ...
        amount: U256,            // motes committed to this position
        opened_tx: String,       // tx hash that created the position
    ) {
        let caller = self.env().caller();
        let is_agent = self.agents.get(&caller).unwrap_or(false);
        require!(self.env(), is_agent, "Only authorised agents");
        require!(self.env(), amount > U256::zero(), "amount must be > 0");
        require!(self.env(), kind.len() <= 32, "kind too long");
        require!(self.env(), target.len() <= 64, "target too long");
        require!(self.env(), opened_tx.len() <= 64, "opened_tx too long");

        let id = self.position_count.get_or_default() + 1u64;
        self.position_count.set(id);
        let pos = Position {
            id,
            kind,
            target,
            amount,
            opened_ts: self.env().get_block_time(),
            opened_tx: opened_tx.clone(),
            realised_yield: U256::zero(),
            is_closed: false,
            closed_ts: 0u64,
            closed_tx: String::new(),
        };
        self.positions.push(pos.clone());
        self.env().emit_event(VaultPositionOpened {
            id,
            kind: pos.kind.clone(),
            target: pos.target.clone(),
            amount: pos.amount,
            agent: caller,
            opened_tx: pos.opened_tx.clone(),
        });
    }

    /// Record realised yield from a position (e.g. after the agent claims
    /// staking rewards or LP fees). Increases total_yield_realised.
    pub fn record_yield_realised(
        &mut self,
        position_id: u64,
        yield_amount: U256,
        source_tx: String,        // tx hash that claimed the yield
    ) {
        let caller = self.env().caller();
        let is_agent = self.agents.get(&caller).unwrap_or(false);
        require!(self.env(), is_agent, "Only authorised agents");
        require!(self.env(), yield_amount > U256::zero(), "yield must be > 0");
        require!(self.env(), source_tx.len() <= 64, "source_tx too long");

        // Find the position by id (List is 1-indexed by insertion order).
        let n = self.positions.len();
        let mut found_idx: u32 = u32::MAX;
        for i in 0..n {
            if let Some(p) = self.positions.get(i) {
                if p.id == position_id {
                    found_idx = i;
                    break;
                }
            }
        }
        require!(self.env(), found_idx != u32::MAX, "position not found");

        let mut pos = self.positions.get(found_idx).unwrap();
        pos.realised_yield = pos.realised_yield + yield_amount;
        self.positions.replace(found_idx, pos.clone());

        self.total_yield_realised.set(
            self.total_yield_realised.get_or_default() + yield_amount
        );
        self.env().emit_event(VaultYieldRealised {
            position_id,
            yield_amount,
            new_position_total: pos.realised_yield,
            total_yield: self.total_yield_realised.get_or_default(),
            source_tx,
            agent: caller,
        });
    }

    /// Withdraw CSPR from the vault (e.g. close a position, return to
    /// stakeholder). Callable by an authorised agent. The actual CSPR
    /// transfer happens at the executor side; this records the on-chain
    /// accounting.
    pub fn withdraw_for_strategy(
        &mut self,
        amount: U256,
        reason: String,
    ) {
        let caller = self.env().caller();
        let is_agent = self.agents.get(&caller).unwrap_or(false);
        require!(self.env(), is_agent, "Only authorised agents");
        require!(self.env(), amount > U256::zero(), "amount must be > 0");
        require!(self.env(), amount <= self.custodied_cspr.get_or_default(), "insufficient custodied balance");
        require!(self.env(), reason.len() <= 64, "reason too long");

        self.custodied_cspr.set(
            self.custodied_cspr.get_or_default() - amount
        );
        self.env().emit_event(VaultWithdraw {
            amount,
            agent: caller,
            reason,
            new_custodied: self.custodied_cspr.get_or_default(),
        });
    }

    // -------- v0.8.1+: View functions for fund custodian state --------

    pub fn get_custodied_cspr(&self) -> U256 {
        self.custodied_cspr.get_or_default()
    }

    pub fn get_total_custodied(&self) -> U256 {
        self.total_custodied.get_or_default()
    }

    pub fn get_total_yield_realised(&self) -> U256 {
        self.total_yield_realised.get_or_default()
    }

    pub fn get_position_count(&self) -> u64 {
        self.position_count.get_or_default()
    }

    pub fn get_position(&self, id: u64) -> Position {
        let n = self.positions.len();
        for i in 0..n {
            if let Some(p) = self.positions.get(i) {
                if p.id == id {
                    return p;
                }
            }
        }
        // Not found — return zeroed Position.
        Position {
            id: 0u64,
            kind: String::new(),
            target: String::new(),
            amount: U256::zero(),
            opened_ts: 0u64,
            opened_tx: String::new(),
            realised_yield: U256::zero(),
            is_closed: false,
            closed_ts: 0u64,
            closed_tx: String::new(),
        }
    }
}

// -------- v0.8.1+ events for fund custodian --------

#[odra::event]
pub struct VaultDeposit {
    pub amount: U256,
    pub agent: Address,
    pub source: String,
    pub new_custodied: U256,
}

#[odra::event]
pub struct VaultWithdraw {
    pub amount: U256,
    pub agent: Address,
    pub reason: String,
    pub new_custodied: U256,
}

#[odra::event]
pub struct VaultPositionOpened {
    pub id: u64,
    pub kind: String,
    pub target: String,
    pub amount: U256,
    pub agent: Address,
    pub opened_tx: String,
}

#[odra::event]
pub struct VaultYieldRealised {
    pub position_id: u64,
    pub yield_amount: U256,
    pub new_position_total: U256,
    pub total_yield: U256,
    pub source_tx: String,
    pub agent: Address,
}

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
        assert!(v.is_agent(owner));
        assert!(v.is_agent(agent));
        assert_eq!(v.get_total_strategies(), U64::zero());
    }
}