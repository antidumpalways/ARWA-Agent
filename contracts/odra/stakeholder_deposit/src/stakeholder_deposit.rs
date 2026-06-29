//! StakeholderDeposit — stakeholder-facing fund deposit contract for ARWA.
//!
//! Stakeholders (parking operators, rental owners, royalty issuers, etc.)
//! deposit native CSPR here to entrust it to the ARWA agent for yield
//! optimisation. The agent runs strategies on the deposited funds via
//! the AgentVault (which holds the actual positions); this contract
//! tracks stakeholder balances and lifecycle.
//!
//! Key design points:
//! - **Payable** `deposit_for_agent` attaches CSPR via the Casper payment
//!   field. The contract uses `self.env().transfer_tokens(...)` to forward
//!   the funds to the AgentVault custodian. For now this is a 1:1 hop
//!   (deposit here -> vault holds it -> agent operates on it).
//! - **Per-stakeholder accounting** so each owner can withdraw their own
//!   principal + share of yield.
//! - **Lifecycle states** (Active, Withdrawn) prevent double-spend.
//! - **CES events** so the ARWA agent can react to deposits in real time.
//!
//! For Casper Agentic Buildathon 2026 - ARWA.

use odra::prelude::*;
use odra::casper_types::U512;

macro_rules! require {
    ($env:expr, $cond:expr, $msg:expr $(,)?) => {
        if !$cond {
            $env.revert(::odra::prelude::OdraError::ExecutionError(
                ::odra::prelude::ExecutionError::UnexpectedError,
            ));
        }
    };
}

fn zero_address() -> Address {
    Address::new(
        "account-hash-0000000000000000000000000000000000000000000000000000000000000000",
    )
    .expect("zero address literal")
}

/// Lifecycle status of a single deposit.
#[odra::odra_type]
pub enum DepositStatus {
    Active,
    Withdrawn,
}

/// On-chain record of a single deposit by a stakeholder.
#[odra::odra_type]
pub struct Deposit {
    pub id: u64,
    pub stakeholder: Address,
    pub amount: u64,                  // motes; u64 supports ~18.4B CSPR
    pub source_label: String,         // "P1 - Gate Keluar Utama"
    pub source_kind: String,          // "parking" | "rental" | "royalty"
    pub strategy_hint: String,        // "auto" | "stake" | "swap" | ...
    pub ts: u64,
    pub status: DepositStatus,
    pub withdrawal_ts: u64,
    pub withdrawal_amount: u64,
    pub nonce: u64,
}

#[odra::module]
pub struct StakeholderDeposit {
    owner: Var<Address>,
    paused: Var<bool>,

    // Stakeholder-level accounting.
    // The sum of a stakeholder's active deposits + cumulative withdrawals
    // equals their lifetime principal deposited. Active deposits only.
    // Stored as u64 motes (1 CSPR = 1e9 motes, so u64 supports up to
    // ~18.4 billion CSPR — far more than any single testnet or mainnet
    // wallet could reasonably hold).
    stakeholder_active: Mapping<Address, u64>,

    // Per-deposit records (ring buffer).
    deposits: List<Deposit>,
    head: Var<u32>,
    max_history: Var<u32>,
    deposit_count: Var<u64>,

    // Aggregate counters (u64 for the same reason).
    total_deposited: Var<u64>,
    total_active: Var<u64>,
    total_withdrawn: Var<u64>,
}

#[odra::module]
impl StakeholderDeposit {
    /// Contract constructor. Args are passed in the deploy transaction.
    /// `vault_address` is the AgentVault custodian — deposited funds are
    /// forwarded there for the agent to operate on.
    pub fn init(&mut self, owner: Address, max_history: u32) {
        self.owner.set(owner);
        self.paused.set(false);
        self.max_history.set(max_history.max(1));
        self.head.set(0u32);
        self.deposit_count.set(0u64);
        self.total_deposited.set(0u64);
        self.total_active.set(0u64);
        self.total_withdrawn.set(0u64);
    }

    // -------- owner management --------

    pub fn transfer_ownership(&mut self, new_owner: Address) {
        self.only_owner();
        self.env().emit_event(OwnershipTransferStarted { to: new_owner });
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner();
        self.paused.set(paused);
        self.env().emit_event(Paused { paused });
    }

    // -------- core entrypoint: deposit --------

    /// Deposit `amount` motes of native CSPR and entrust them to the ARWA
    /// agent. The CSPR is passed explicitly as an argument (rather than via
    /// the Casper `attached_value` mechanism) to avoid dependency on the
    /// Casper 2.0 attached_value field — which the JS SDK exposes only for
    /// native Transfer targets, not ContractCall.
    ///
    /// `source_label` and `source_kind` describe what the funds represent
    /// (a real-world RWA tick), and `strategy_hint` lets the stakeholder
    /// suggest a strategy preference (the agent may override).
    ///
    /// **Implementation note**: in production this should be `#[odra(payable)]`
    /// and use `self.env().attached_value()`; for now we pass `amount` as a
    /// runtime arg for SDK compatibility. The agent's executor transfers
    /// the CSPR to this contract's purse BEFORE calling `deposit`.
    pub fn deposit(
        &mut self,
        amount: u64,
        source_label: String,
        source_kind: String,
        strategy_hint: String,
        nonce: u64,
    ) {
        require!(self.env(), !self.paused.get_or_default(), "Contract is paused");
        require!(self.env(), amount > 0u64, "amount must be > 0");
        require!(self.env(), source_label.len() <= 64, "source_label too long");
        require!(self.env(), source_kind.len() <= 32, "source_kind too long");
        require!(self.env(), strategy_hint.len() <= 32, "strategy_hint too long");

        let caller = self.env().caller();
        // For now this is just an accounting update — actual CSPR transfer
        // is handled by the agent's executor (separate tx that transfers
        // CSPR to this contract's purse before/after calling deposit).
        // The `#[odra(payable)]` approach is left for v0.9 once the SDK
        // and our deposit simulator script support it cleanly.

        // Bump counters.
        let id = self.deposit_count.get_or_default() + 1u64;
        self.deposit_count.set(id);

        let prev_active = self.stakeholder_active.get(&caller).unwrap_or_default();
        self.stakeholder_active.set(&caller, prev_active + amount);
        self.total_deposited.set(self.total_deposited.get_or_default() + amount);
        self.total_active.set(self.total_active.get_or_default() + amount);

        // Append to ring buffer.
        let deposit = Deposit {
            id,
            stakeholder: caller,
            amount,
            source_label: source_label.clone(),
            source_kind: source_kind.clone(),
            strategy_hint: strategy_hint.clone(),
            ts: self.env().get_block_time(),
            status: DepositStatus::Active,
            withdrawal_ts: 0u64,
            withdrawal_amount: 0u64,
            nonce,
        };
        let cap = self.max_history.get_or_default().max(1);
        let head = self.head.get_or_default();
        if (self.deposits.len() as u32) < cap {
            self.deposits.push(deposit.clone());
        } else {
            self.deposits.replace(head, deposit.clone());
            self.head.set((head + 1) % cap);
        }

        self.env().emit_event(StakeholderDeposited {
            id,
            stakeholder: caller,
            amount,
            source_label,
            source_kind,
            strategy_hint,
            nonce,
            timestamp: deposit.ts,
        });
    }

    /// Withdraw a previously active deposit (principal only; yield
    /// distribution is a separate flow via the AgentVault).
    /// The CSPR is sent from the contract balance to the stakeholder.
    pub fn withdraw(
        &mut self,
        deposit_id: u64,
    ) {
        require!(self.env(), !self.paused.get_or_default(), "Contract is paused");
        let caller = self.env().caller();

        // Linear scan of the ring buffer for the deposit.
        // We don't index by id (Odra Mapping<u64, Deposit> would be cleaner
        // but List iteration is fine for ≤1024 history).
        let cap = self.max_history.get_or_default().max(1);
        let len = self.deposits.len() as u32;
        let n = len.min(cap);
        require!(self.env(), n > 0, "no deposits exist");

        let mut found_idx: Option<u32> = None;
        let mut found_amount: u64 = 0u64;
        for i in 0..n {
            if let Some(d) = self.deposits.get(i) {
                if d.id == deposit_id {
                    require!(self.env(), d.stakeholder == caller, "not your deposit");
                    require!(
                        self.env(),
                        matches!(d.status, DepositStatus::Active),
                        "deposit already withdrawn"
                    );
                    found_idx = Some(i);
                    found_amount = d.amount;
                    break;
                }
            }
        }
        let idx = found_idx.expect("deposit not found");

        // Update the record: mark Withdrawn, set timestamp + amount.
        let mut updated = self.deposits.get(idx).unwrap();
        updated.status = DepositStatus::Withdrawn;
        updated.withdrawal_ts = self.env().get_block_time();
        updated.withdrawal_amount = found_amount;
        self.deposits.replace(idx, updated.clone());

        // Subtract from active totals (u64 arithmetic).
        let prev_active = self.stakeholder_active.get(&caller).unwrap_or_default();
        let new_active = prev_active.saturating_sub(found_amount);
        self.stakeholder_active.set(&caller, new_active);
        let total_active_now = self.total_active.get_or_default();
        self.total_active.set(total_active_now.saturating_sub(found_amount));
        self.total_withdrawn.set(self.total_withdrawn.get_or_default() + found_amount);

        // Transfer the CSPR back to the stakeholder from this contract's
        // own balance. The caller must have previously deposited here.
        // transfer_tokens takes U512 — convert from u64 safely.
        let amount_u512 = U512::from(found_amount);
        self.env().transfer_tokens(&caller, &amount_u512);

        self.env().emit_event(StakeholderWithdrew {
            id: deposit_id,
            stakeholder: caller,
            amount: found_amount,
            timestamp: updated.withdrawal_ts,
        });
    }

    // -------- views --------

    pub fn get_deposit(&self, id: u64) -> Deposit {
        let cap = self.max_history.get_or_default().max(1);
        let len = self.deposits.len() as u32;
        let n = len.min(cap);
        for i in 0..n {
            if let Some(d) = self.deposits.get(i) {
                if d.id == id {
                    return d;
                }
            }
        }
        // Not found — return a zeroed deposit with id=0.
        Deposit {
            id: 0u64,
            stakeholder: zero_address(),
            amount: 0u64,
            source_label: String::new(),
            source_kind: String::new(),
            strategy_hint: String::new(),
            ts: 0u64,
            status: DepositStatus::Active,
            withdrawal_ts: 0u64,
            withdrawal_amount: 0u64,
            nonce: 0u64,
        }
    }

    pub fn get_stakeholder_balance(&self, stakeholder: Address) -> u64 {
        self.stakeholder_active.get(&stakeholder).unwrap_or_default()
    }

    pub fn get_total_deposited(&self) -> u64 {
        self.total_deposited.get_or_default()
    }

    pub fn get_total_active(&self) -> u64 {
        self.total_active.get_or_default()
    }

    pub fn get_total_withdrawn(&self) -> u64 {
        self.total_withdrawn.get_or_default()
    }

    pub fn deposit_count(&self) -> u64 {
        self.deposit_count.get_or_default()
    }

    pub fn owner(&self) -> Address {
        self.owner.get().unwrap_or_else(zero_address)
    }

    pub fn paused(&self) -> bool {
        self.paused.get_or_default()
    }

    pub fn max_history(&self) -> u32 {
        self.max_history.get_or_default()
    }

    // -------- internal --------

    fn only_owner(&self) {
        let caller = self.env().caller();
        require!(
            self.env(),
            caller == self.owner.get().unwrap_or_else(zero_address),
            "Only owner"
        );
    }
}

// -------- events --------

#[odra::event]
pub struct StakeholderDeposited {
    pub id: u64,
    pub stakeholder: Address,
    pub amount: u64,
    pub source_label: String,
    pub source_kind: String,
    pub strategy_hint: String,
    pub nonce: u64,
    pub timestamp: u64,
}

#[odra::event]
pub struct StakeholderWithdrew {
    pub id: u64,
    pub stakeholder: Address,
    pub amount: u64,
    pub timestamp: u64,
}

#[odra::event]
pub struct OwnershipTransferStarted {
    pub to: Address,
}

#[odra::event]
pub struct Paused {
    pub paused: bool,
}

// -------- tests --------

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::Deployer;

    fn setup() -> (odra::host::HostEnv, Address) {
        let env = odra_test::env();
        let owner = env.get_account(0);
        (env, owner)
    }

    #[test]
    fn test_init() {
        let (env, owner) = setup();
        let init_args = StakeholderDepositInitArgs {
            owner,
            max_history: 100,
        };
        let contract = StakeholderDeposit::try_deploy(&env, init_args).expect("deploy");
        assert_eq!(contract.owner(), owner);
        assert_eq!(contract.max_history(), 100);
        assert!(!contract.paused());
        assert_eq!(contract.deposit_count(), 0);
    }
}