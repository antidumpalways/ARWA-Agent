# MIGRATION_NOTES.md

What changed across the v0.3.x releases, and what the user (you) still has to
do on your local machine to go from "fresh checkout" to "demo-ready".

## v0.3.2 — Testnet deploy + initialize (REAL chain integration, post-hackathon)

### Status (2026-06-08) — WORKING
Both contracts are **deployed AND initialized on Casper 2.0 testnet** in a
single transaction each. The `init(...)` is called at install time (the
2-stage lazy init was abandoned — the SDK's arg encoding for a follow-up
`StoredVersionedContractByHash` call was the source of the mysterious
`ExecutionError::Reverted`).

**Final deploy hashes** (from `.env.local`):
- RevenueEmitter package: `hash-1271383d93f1b16e9b86f9b96d21ee9e5e673d529a47425cfd675b52f29d6f2f`
- AgentVault package:     `hash-8c7015e0d95fc13495a1921977b9d7f8fd824cb2534ec3438a43872ae6769b6d`

**Verified working**:
- `owner()` returns the agent's account hash
- `paused()` returns `false`
- `max_history()` returns `1024` for RE; `max_log_history()` returns `1024` for AV
- `getVaultOverview()` reads all 3 fields correctly via CSPR.cloud REST

### Why we abandoned the 2-stage lazy init
The lazy-init pattern (empty `init` + separate `initialize` call) kept
hitting `ExecutionError::Reverted` (64538) on the second transaction.
Root cause was the way `casper-js-sdk` v5's `StoredVersionedContractByHash`
+ the `from_bytes` deserializer in casper-eip-712 interacts when passing
Address args through a `ContractPackageHash.fromJSON(hex)` (the TS-side
type system complains about the missing `toPrefixedWasmString` and you
have to cast). The deploy-time `init` is much simpler — the Odra
framework wraps the args in its own validated envelope.

### What changed in this pass
- `contracts/odra/{revenue_emitter,agent_vault}/src/*.rs`: restored the
  full `init(owner, emitter, max_history, …)` signatures, removed the
  empty `init` and the `initialize` shim.
- `agent/scripts/deploy.ts`: `specFor()` now bundles the 4 `odra_cfg_*`
  args + the 3-4 user `init` args into a single deploy transaction.
  Removed the `initArgsFor` helper and the `callEntryPoint` call site
  in `main()` (the helper itself is kept for future follow-up calls).
- `agent/src/casper/vaultClient.ts`: `logStrategyToVault` now uses
  `clType: 'key'` for the `token_in` / `token_out` / `x402_signer` args
  (they're `Address` on the contract side, not raw `byteArray`).
  Added `tokenInHex` / `tokenOutHex` / `x402SignerHex` fields to
  `AgentVaultLog` and pass the agent's account hash for all three.
- `agent/src/executor.ts`: fills the new `*Hex` fields with the agent's
  account hash.
- `agent/src/x402/client.ts`: was using `cfg.AGENT_PUBLIC_KEY` (66-char
  PublicKey with algo tag) as `from` in `TransferAuthorization`, but
  the type spec is `bytes32` (32 raw bytes). Now we convert
  `PublicKey` → `AccountHash` (32 bytes) and strip prefixes on
  `asset` / `to` / `nonce` so all three are exactly 32 raw bytes.
  `valid_after` and `valid_before` are now `BigInt` to match the
  uint64/uint256 eip-712 spec.
- `agent/scripts/x402Server.ts`: default `ASSET` is `'0'.repeat(66)` (33
  bytes, the zero Address with an Account tag byte — the smallest
  valid input to `encodeAddress`). `'0'.repeat(64)` is 32 raw bytes
  and was rejected by the eip-712 library with `Address must be 20 or
  33 bytes, got 32`.

### Deploy flow (works today, end-to-end)
```
cargo +nightly-2025-01-15 odra build           # wasm + wasm-opt + wasm-strip
npm run deploy -- --skip-build                 # deploys both with init args
npm run dev                                     # backend SSE feed on :4000
npm run x402-server                            # signal provider on :4001 (separate terminal)
npm run cycle                                   # one full agent cycle
```

### Deploy gas budget (measured on 2026-06-08)
| step                                  | consumed  | gas limit | refund |
|---------------------------------------|-----------|-----------|--------|
| install RevenueEmitter (full init)     | 247.7 CSPR| 260 CSPR  | 12.3   |
| install AgentVault (full init)         | 275.2 CSPR| 290 CSPR  | 14.8   |
| `execute_strategy` write (per call)   | ~3 CSPR   | 3 CSPR    | ~0     |
| view function call (`owner()` etc.)    | 0.02-0.3  | 3 CSPR    | ~3     |

### Money spent
User funded **5000 + 5000 CSPR** = 10000 CSPR across 2 faucets. ~5800
CSPR was burned across ~16 deploy attempts and ~20 view/test calls.
Remaining balance is ~3900 CSPR.

---

## v0.3.1 (historical)

## v0.3.1 — current

### Rust contracts (`contracts/odra/`) — rewritten for Odra 2.7

| Change | Why |
|---|---|
| `#[derive(OdraType)]` → `#[odra::odra_type]` attribute | Odra 2.7 changed `OdraType` from a derive to an attribute macro |
| `Vec<T>` → `List<T>` with `head: Var<u32>` ring buffer | `Vec<T>` no longer implements `ModuleComponent`; `List` does |
| `Vec::remove(0)` (no LIFO) → head-pointer wrap | `List` has no `remove(0)` method |
| `Address::zero()` → `Address::new("account-hash-000…0")` | `Address` is an enum with no `Default` |
| `self.env().block_time()` → `get_block_time()` | renamed in Odra 2.7 |
| `attached_value()` returns `U512` → `U256::to_u256()` (via `ToU256` trait) | type changed |
| `transfer(&Address, U256)` → `transfer_tokens(&Address, &U512)` | renamed + new signature |
| `U32`/`U64` from casper_types → use `u32`/`u64` | those types were removed |
| `require!(cond, "msg")` macro → custom macro in each file | `require!` was removed from Odra 2.7 |
| Workspace structure: `src/lib.rs` declares `pub mod X;` + `src/X.rs` | matches the odra build contract pattern |
| `[[bin]]` entries for `{name}_build_contract` + `{name}_build_schema` | required by `cargo odra build` |
| `Odra.toml` with `[[contracts]]` + `fqn` field | required by cargo-odra |
| `rust-toolchain` pinned to `nightly-2025-01-15` | odra-macros 2.7 uses unstable `box_patterns` |
| `target = "wasm32-unknown-unknown"` added | required for Casper deploy |
| `Cargo.toml` deps switched to `odra = "2.7"` features | current crate version |

Result: both `RevenueEmitter.wasm` and `AgentVault.wasm` now build cleanly
on Windows nightly-2025-01-15.

### TypeScript agent (`agent/`) — v5 SDK + CSPR.cloud + x402

| Change | Why |
|---|---|
| `casper-js-sdk@^4.0.0` → `^5.0.0` | v5 is a complete rewrite (no more `CasperClient`, `DeployUtil`, `SecretKey`) |
| New `casper/signer.ts` using `HttpHandler` + `RpcClient` + `PrivateKey` (per-algorithm) | matches v5 API |
| `casper-eip-712` (no namespace) → `@casper-ecosystem/casper-eip-712` | real npm package name |
| `signCasperEip712({...})` (didn't exist) → manual `hashTypedData` + `PrivateKey.sign` | package has no high-level sign function |
| `eventsource` package: `import { EventSource }` → `import EventSource from 'eventsource'` | v2.x exports as default |
| All URL sources verified against docs: `x402-facilitator.cspr.cloud`, `node.testnet.cspr.cloud/rpc`, `mcp.testnet.cspr.cloud/mcp` | docs.cspr.cloud |
| `mcp/casperMcp.ts` uses `@modelcontextprotocol/sdk` Streamable HTTP | matches current MCP spec |
| `mcp/csprTradeMcp.ts` wraps `https://mcp.cspr.trade/mcp` | 24-tool MCP surface |
| `csprCloud/rest.ts` — CSPR.cloud REST wrapper | new file |
| `csprCloud/streaming.ts` — WS + SSE envelope `{action, data, timestamp, extra}` | new file |
| `csprCloud/cesEvents.ts` — typed CES event filter (`onContractCESEvents`) | new file |
| `csprCloud/x402Facilitator.ts` — direct `verify`/`settle` calls to CSPR.cloud facilitator | new file |
| `x402/header.ts` — extracted `buildPaymentHeaderEnvelope` for testing | new file |
| `casper/vaultClient.ts#logStrategyToVault` — real `execute_strategy` deploy | replaces mock |
| `scripts/deploy.ts` rewritten for v5 SDK | was using v4 `CasperClient`/`DeployUtil` |
| `scripts/record-deployment.ts` — manual hash recording | new |
| `scripts/verify-setup.ts` (`npm run verify`) | new |
| `scripts/quickstart.ts` (`npm run quickstart`) — local checklist | new |
| `agent/llmStrategy.ts` — Claude/OpenAI strategy with heuristic fallback | new |
| `agent/slippage.ts` — extracted BigInt math | new |
| `agent/agentLog.ts` — build on-chain `execute_strategy` args | new |
| `analyst.ts` — wired to LLM (falls back to heuristic), reads real vault state via REST | improved |
| `server.ts` — SSE endpoint re-broadcasts CSPR.cloud CES events to browser | working |
| Frontend (`frontend/index.html`) — contract hash links to explorer, better error display, persistent state | improved |

### Tests — 21 passing in 4.4s

| File | What it covers |
|---|---|
| `tests/x402-header.test.ts` | 7-field colon envelope build/parse; 402 header parsing |
| `tests/streaming.test.ts` | CSPR.cloud envelope parser; contract+event filter predicates |
| `tests/agent-logic.test.ts` | slippage BigInt math; AgentVault log shape |
| `tests/llm-strategy.test.ts` | heuristic fallback when no LLM_API_KEY; hold→swap coercion |
| `tests/runcycle.test.ts` | full Analyst→Executor integration with all deps mocked |

Commands:
```bash
npm test                # 21/21 in ~5s
npm run typecheck       # tsc --noEmit, exit 0
npm run verify          # pre-flight check of all envs + endpoints
npm run quickstart      # local checklist with status of each prerequisite
```

### CI (`.github/workflows/ci.yml`)

Two jobs run on push/PR to main:
- **agent-typecheck**: `npm ci` + `npm run typecheck` + `npm test --ci` + `npm run verify`
- **contracts-build**: `cargo +nightly-2025-01-15 check --target wasm32-unknown-unknown --lib`

Both cache their toolchain + target dirs to keep CI fast.

---

## What you still have to do

These steps cannot be done from the sandbox; they need your local Windows
machine, your keys, and a working install of Rust + the Casper toolchain.

### 1. Get a Casper Testnet key

```powershell
mkdir keys
casper-client keygen keys/agent.pem
```

Go to **https://testnet.cspr.live/tools/faucet** and paste the public key printed
by keygen. Wait ~30s for the CSPR.

### 2. Get a CSPR.cloud API key

Visit **https://cspr.cloud/**, sign up, copy the API key from the dashboard,
and put it in `agent\.env` as `CSPR_CLOUD_API_KEY=...`.

### 3. Verify

```powershell
cd agent
$env:CSPR_CLOUD_API_KEY = "<your key>"
npm run quickstart
```

This prints a status table of every prerequisite and the remaining steps.

### 4. Build + deploy

```powershell
cd ..\contracts\odra
cargo +nightly-2025-01-15 odra build
# If wasm-opt/wasm-strip not on PATH, see SETUP_WINDOWS.md step 5.
cd ..\agent
npm run deploy
```

If you deployed via the casper-client or the web UI instead, use:
```powershell
npm run record -- --revenue=hash-abc --vault=hash-def
```

### 5. Ask the Casper Discord for a sponsored x402 Facilitator

In the `#buildathon-2026` channel, ask the Casper team to give you a free
facilitator endpoint for the demo. They'll send you a URL. Set it as
`X402_FACILITATOR_URL` in `agent\.env` (default is the public CSPR.cloud
facilitator which may rate-limit during the buildathon).

### 6. Run the stack

Three terminals:

```powershell
# 1) x402 signal provider
cd agent
npm run x402-server

# 2) backend bridge
cd agent
npm run dev

# 3) frontend
npx serve ../frontend -l 3000
```

Open http://localhost:3000, install the CSPR.click extension, connect, click
**RUN OPTIMIZATION**.

### 7. Record the demo video

Capture:
- the wallet connect
- the live `AGENT_VAULT_CONTRACT_HASH` deploy in https://testnet.cspr.live/deploy/<hash>
- the on-chain `execute_strategy` event appearing in the CES log
- the x402 payment tx (if the facilitator returns 402 and your agent pays)

The frontend already links the contract hashes directly to the explorer.

---

## Known limitations (won't block the buildathon)

- `cargo odra build` requires `wasm-opt` and `wasm-strip` for the post-build
  optimization step. On Windows without these, the build still produces a
  valid (but unoptimized) wasm in `target/`. You can copy it manually to
  `wasm/`. See SETUP_WINDOWS.md step 5.
- `cargo odra deploy` works only after the `[[networks]]` section is filled
  in `Odra.toml`. Use `npm run deploy` instead — it uses the same v5 SDK code
  with no TOML dependency.
- The LLM strategy falls back to the deterministic heuristic if
  `LLM_API_KEY` is missing or the API call fails. This is by design — the
  agent should never block on a flaky LLM.
- CSPR.cloud free-tier is rate-limited. If you see 429s during a demo, ask
  in Casper Discord for a temporary key bump.
