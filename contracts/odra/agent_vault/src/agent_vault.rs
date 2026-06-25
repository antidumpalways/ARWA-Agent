//! AgentVault - minimal version with execute_strategy only
//! Rebuilt 2026-06-21 to fix the deployed contract that was actually RevenueEmitter.

use odra::prelude::*;
use odra::casper_types::{U256, U512};

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