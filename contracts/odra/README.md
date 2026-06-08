# Odra Contracts — ParkFlow Agent

Two contracts deployed to Casper Testnet via `cargo odra`.

## Layout
- `Odra.toml` — workspace + network config (`cargo odra deploy --network casper-test` reads from here)
- `Cargo.toml` — Rust workspace
- `revenue_emitter/` — pushes RWA cashflow events
- `agent_vault/` — receives deposits, executes agent strategies, logs decisions

## Build

```bash
# from contracts/odra
cargo odra build
```

## Deploy

```bash
# from the repo root (after .env is configured)
cd agent && npm run deploy
```

This reads `AGENT_SECRET_KEY_PATH` from `.env`, builds the wasm, and submits two
deploys to the configured network. The contract hashes are written to
`REVENUE_EMITTER_CONTRACT_HASH` and `AGENT_VAULT_CONTRACT_HASH` in `.env.local`.

## Test

```bash
cargo odra test
```

## Schema (for frontend/MCP)

```bash
cargo odra schema
# → contracts/odra/schema/{revenue_emitter,agent_vault}.json
```

The CSPR.trade MCP and Casper MCP use the generated schema to call entrypoints
by name with typed args.

## Ownership / agent model

* `owner` — set once in `init`, can `transfer_ownership` (two-step),
  `set_agent`, `set_paused`, `set_min_strategy_amount`, `set_emitter` (emitter
  contract only), `withdraw`.
* `agent` — the only address allowed to call `execute_strategy`.
* `emitter` (RevenueEmitter only) — the only address allowed to call
  `emit_revenue` (besides the owner).

Both contracts emit granular events; a CSPR.cloud indexer (or the
`get_decision_log` / `get_recent_events` views) can be used to build a
reputation dashboard.
