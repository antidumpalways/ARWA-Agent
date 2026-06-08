//! RevenueEmitter - emits RWA revenue events (Parking Blox style) on-chain.
//!
//! Access control: only the registered `emitter` (typically a backend service
//! that aggregates real-world cashflow data) or the contract `owner` may push
//! events. Anyone can read recent events.
//!
//! For Casper Agentic Buildathon 2026 - ParkFlow Agent.

use odra::prelude::*;
use odra::casper_types::U256;

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

/// On-chain record of a single RWA revenue tick.
#[odra::odra_type]
pub struct RevenueEvent {
    pub timestamp: u64,
    pub amount: U256,
    pub asset: Address,       // CEP-18 contract hash, or native (Address::zero())
    pub source: String,       // e.g. "parking-lot-42"
    pub emitter: Address,     // who pushed the event
    pub reference: String,    // off-chain reference id (invoice, etc.)
}

/// "Zero" address sentinel: an Account variant with all-zero AccountHash.
/// Used to mean "no address set" / "anyone".
fn zero_address() -> Address {
    Address::new(
        "account-hash-0000000000000000000000000000000000000000000000000000000000000000",
    )
    .expect("zero address literal")
}

#[odra::module]
pub struct RevenueEmitter {
    owner: Var<Address>,
    emitter: Var<Address>,                  // authorized pusher
    pending_owner: Var<Address>,           // two-step ownership transfer
    paused: Var<bool>,
    // Circular ring buffer of events implemented with List + head pointer.
    // We don't actually shift elements — when head reaches cap we wrap around
    // by overwriting in place. `get_recent_events` reads the last `limit` in
    // chronological order.
    events: List<RevenueEvent>,
    head: Var<u32>,                          // next slot to write
    total_emitted: Mapping<Address, U256>,   // per-asset lifetime totals
    max_history: Var<u32>,                   // ring buffer cap
}

#[odra::module]
impl RevenueEmitter {
    /// Contract constructor. Args are passed in the deploy transaction.
    /// Fits the 100 CSPR testnet block gas limit (~247 CSPR consumed at the
    /// 2026-06-08 deploy).
    pub fn init(&mut self, owner: Address, emitter: Address, max_history: u32) {
        self.owner.set(owner);
        self.emitter.set(emitter);
        self.paused.set(false);
        self.max_history.set(max_history.max(1));
        self.head.set(0u32);
    }

    // -------- owner / emitter management --------

    pub fn transfer_ownership(&mut self, new_owner: Address) {
        self.only_owner();
        self.pending_owner.set(new_owner);
    }

    pub fn accept_ownership(&mut self) {
        let caller = self.env().caller();
        let pending = self.pending_owner.get().unwrap_or_else(zero_address);
        require!(self.env(), pending != zero_address(), "No pending ownership transfer");
        require!(self.env(), caller == pending, "Only pending owner can accept");
        let prev = self.owner.get().unwrap_or_else(zero_address);
        self.owner.set(caller);
        self.pending_owner.set(zero_address());
        self.env().emit_event(OwnershipTransferred { from: prev, to: caller });
    }

    pub fn set_emitter(&mut self, new_emitter: Address) {
        self.only_owner();
        self.emitter.set(new_emitter);
        self.env().emit_event(EmitterUpdated { new_emitter });
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner();
        self.paused.set(paused);
        self.env().emit_event(Paused { paused });
    }

    // -------- core entrypoint --------

    /// Emit a new revenue event. Only callable by `emitter` or `owner`.
    pub fn emit_revenue(
        &mut self,
        amount: U256,
        asset: Address,
        source: String,
        reference: String,
    ) {
        require!(self.env(), !self.paused.get_or_default(), "Contract is paused");
        let caller = self.env().caller();
        let is_emitter = caller == self.emitter.get().unwrap_or_else(zero_address);
        let is_owner = caller == self.owner.get().unwrap_or_else(zero_address);
        require!(self.env(), is_emitter || is_owner, "Not authorized to emit");
        require!(self.env(), amount > U256::zero(), "Amount must be > 0");
        require!(self.env(), source.len() <= 64, "source too long");
        require!(self.env(), reference.len() <= 128, "reference too long");

        let event = RevenueEvent {
            timestamp: self.env().get_block_time(),
            amount,
            asset,
            source: source.clone(),
            emitter: caller,
            reference: reference.clone(),
        };

        // Ring buffer: cap may have grown after init.
        let cap = self.max_history.get_or_default().max(1);
        let head = self.head.get_or_default();
        // If buffer is smaller than cap, push; else overwrite head and advance.
        if self.events.len() < cap {
            self.events.push(event.clone());
        } else {
            // Replace the slot at `head` and advance head (wrap).
            self.events.replace(head, event.clone());
            let next_head = (head + 1) % cap;
            self.head.set(next_head);
        }

        // Track per-asset totals
        let prev = self.total_emitted.get(&asset).unwrap_or_default();
        self.total_emitted.set(&asset, prev + amount);

        self.env().emit_event(RevenueEmitted {
            amount,
            asset,
            source,
            timestamp: event.timestamp,
            emitter: caller,
            reference,
        });
    }

    // -------- views --------

    /// Returns the most recent up to `limit` events in chronological order
    /// (oldest first). If the ring buffer is full, wraps around correctly.
    pub fn get_recent_events(&self, limit: u32) -> Vec<RevenueEvent> {
        let cap = self.max_history.get_or_default().max(1) as usize;
        let len = (self.events.len() as usize).min(cap);
        let l = (limit as usize).min(len);
        if len == 0 || l == 0 {
            return Vec::new();
        }

        let head = self.head.get_or_default() as usize;
        // If buffer not full yet, head is 0 and events are at 0..len.
        if (self.events.len() as usize) < cap {
            let start = (self.events.len() as usize).saturating_sub(l);
            let mut out = Vec::new();
            for i in start..self.events.len() as usize {
                if let Some(ev) = self.events.get(i as u32) {
                    out.push(ev);
                }
            }
            return out;
        }

        // Buffer full: oldest event is at `head` (next slot to overwrite),
        // newest is at `(head - 1) mod cap`. Walk backward `l` slots.
        let mut out = Vec::new();
        let mut idx = (head + cap - 1) % cap;
        for _ in 0..l {
            if let Some(ev) = self.events.get(idx as u32) {
                out.push(ev);
            }
            idx = (idx + cap - 1) % cap;
        }
        out.reverse();
        out
    }

    pub fn get_total_emitted(&self, asset: Address) -> U256 {
        self.total_emitted.get(&asset).unwrap_or_default()
    }

    pub fn owner(&self) -> Address {
        self.owner.get().unwrap_or_else(zero_address)
    }

    pub fn emitter(&self) -> Address {
        self.emitter.get().unwrap_or_else(zero_address)
    }

    pub fn paused(&self) -> bool {
        self.paused.get_or_default()
    }

    pub fn max_history(&self) -> u32 {
        self.max_history.get_or_default()
    }

    pub fn event_count(&self) -> u32 {
        self.events.len() as u32
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
pub struct RevenueEmitted {
    pub amount: U256,
    pub asset: Address,
    pub source: String,
    pub timestamp: u64,
    pub emitter: Address,
    pub reference: String,
}

#[odra::event]
pub struct OwnershipTransferred {
    pub from: Address,
    pub to: Address,
}

#[odra::event]
pub struct EmitterUpdated {
    pub new_emitter: Address,
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

    fn setup() -> (odra::host::HostEnv, Address, Address) {
        let env = odra_test::env();
        let owner = env.get_account(0);
        let emitter = env.get_account(1);
        (env, owner, emitter)
    }

    #[test]
    fn test_init() {
        let (env, owner, emitter) = setup();
        let init_args = RevenueEmitterInitArgs {
            owner,
            emitter,
            max_history: 100,
        };
        let contract = RevenueEmitter::try_deploy(&env, init_args).expect("deploy");
        assert_eq!(contract.owner(), owner);
        assert_eq!(contract.emitter(), emitter);
        assert_eq!(contract.max_history(), 100);
        assert!(!contract.paused());
    }
}
