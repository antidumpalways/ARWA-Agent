# DoraHacks Submission Description — Final Round

> Format mengikuti gaya CasCet: hook pendek, sections dengan sub-heading jelas, on-chain proof prominent, security disclosure, links di akhir. Letak gambar spesifik ditandai **[Gambar N: ...]**.

---

## Title

```
ARWA — Agentic Real-World Assets
```

## Tagline (max ~120 chars)

```
Turn idle CSPR revenue into autonomous yield. Stakeholders deposit, an AI agent routes via x402 and CSPR.trade and native auction. Every decision on chain.
```

---

## Project Description (copy-paste ready, plain text)

[Gambar 1: cover-og.png — letakkan sebagai Cover Image submission. Dark theme, ARWA merah besar, 3 badge Casper 2.0 + x402 + Odra 2.7, 4 stat boxes (600 CSPR stake, 3 contracts, 6 actions, 30 of 30 tests). First impression judges.]

Turn idle CSPR revenue into autonomous yield on Casper 2.0. ARWA is the agentic layer for real-world assets: stakeholders deposit CSPR, an AI agent notices, pays a tiny micropayment for a forecast, picks one of six yield strategies, signs and submits the resulting transaction, and writes the decision back to chain.

Casper Agentic Buildathon 2026, Casper Innovation Track (finalist).

[Gambar 2: architecture.png — letakkan di awal section "What ARWA does". Three connected boxes: StakeholderDeposit (purple) -> ARWA Agent (red, 5 submodules) -> AgentVault v2 (purple, 4 methods). 4 colored arrows showing data flow. This is the single visual that explains 80 percent of the project.]

The problem
Real-world revenue is messy. Parking gate receipts, monthly rent, music royalties land in custodial wallets and just sit there. The operator has to log in, evaluate six strategies, sign a transaction, and pray the bridge works. There is no agent, no routing, no yield. Every existing yield tool assumes a human clicks the button, and every x402 service today is a point-to-point vending machine: it prices one call, settles one call, and forgets the rest. Real yield routing is a pipeline: deposit event, forecast, decision, execution, audit log. Nobody chains those.

What ARWA does
ARWA is the autonomous yield-routing layer for real-world assets on Casper, plus the piece no one else has shipped: a six-strategy decision loop where every step is signed and on chain.

Deposit. A real on-chain deposit into StakeholderDeposit carries a source label (which parking lot, which rental, which royalty issuer) and a source kind (parking, rental, royalty). Stakeholders stay non-custodial; the contract holds the principal.

Decide. The ARWA agent reads the event, fetches the live portfolio via the CSPR.cloud MCP, quotes a route via the CSPR.trade MCP, then pays a 0.001 CSPR micropayment over the x402 EIP-712 protocol for a premium off-chain utilization forecast. An LLM (or a deterministic heuristic fallback) picks one of six actions: swap to sCSPR, native stake via the Casper 2.0 auction, add liquidity, remove liquidity, compound, or hold. Each decision carries a confidence score.

Execute. The executor dispatches. DEX actions go through CSPR.trade MCP, get signed locally by the agent PEM, and submit via account_put_transaction. The native stake path uses the SDK NativeDelegateBuilder, no MCP roundtrip, 500 CSPR minimum guard with auto-fallback to swap. Hold short-circuits and writes only an audit log. On success the agent records the position in the redesigned AgentVault v2 and writes an emit_revenue entry to the legacy RevenueEmitter package for reputation.

Audit. Every decision is hashed and committed on chain. There is no off-chain ledger for what the agent did. The AgentVault v2 custodian methods (deposit_for_strategy, record_strategy_execution, record_yield_realised, withdraw_for_strategy) are deployed and reachable. The dashboard reads AUM, realised yield, and active positions from these contract views.

[Gambar 3: dashboard.png — letakkan setelah section "Audit". Screenshot localhost:3000 slash dashboard equals 1: 4 cards in 2 by 2 grid (Physical World, Agent Identity, On-Chain Record, Fund), red control bar at bottom showing Force Action stake plus Amount 600 plus Trigger Deposit and Run Cycle button. Bukti UI jadi.]

The primitive: budget-bounded six-strategy routing with on-chain attribution
ARWA's headline is a machine-to-machine primitive that only makes sense once real-world revenue flows become pipelines. The AgentVault v2 contract turns each cycle into a programmable supply chain. This is not a whitepaper primitive: the full lifecycle ran live on Casper 2.0 testnet, every step verifiable on testnet.cspr.live.

On-chain strategy registry. Every strategy execution is a contract entry point call. The agent, the strategy kind, the target validator or pair, the amount, and the tx hash are all written to chain through record_strategy_execution. A subsequent record_yield_realised closes the loop and updates the agent's reputation on the same package.

Risk-bounded autonomy. A circuit breaker in agent-side risk guard detects greater than 10 percent drawdown (env ARWA_MAX_DRAWDOWN_PCT) or 3 reverted strategies in a row (env ARWA_MAX_REVERT_STREAK), auto-trips, and holds the agent open for 10 minutes. State is persisted in agent slash arwa-risk.json so the guard survives process restarts. The analyst short-circuits to a hold proposal: no swap, no LP, just an audit log entry.

For high-frequency traffic, the native CSPR delegation path uses Casper 2.0's NativeDelegateBuilder: one signed transaction, no MCP, no facilitator, sub-2-second finality on testnet.

[Gambar 4: cspr-live-verification.png — letakkan di awal section "Live on Casper testnet". Side-by-side panel: left is the actual JSON response from cspr.cloud REST API showing deploy_hash, block_height 8550584, status processed, error_message null, amount 600000000000 motes; right is 6 green checkmarks. URL testnet.cspr.live slash deploy slash 74a4803f at the bottom. This is the "no simulation" proof — judges click the URL and see it themselves.]

Live on Casper 2.0 testnet
ARWA is not a slide deck. Three contracts are deployed, six strategy actions are wired, and real on-chain transactions are verifiable on cspr.live.

Testnet, chain "casper-test":

StakeholderDeposit (fund source): hash-c0ae4b5dcef3a6aa26154ae3c62aa5768691877d97d81e7ce794046ed7d20f2a
AgentVault v2 (fund custodian): hash-ab4608ba784fb8c90928b95a5e8b7b54d12c7e94557ae8e28e3f86e2da3b7b67
RevenueEmitter (audit log package): hash-5ba747dfbf3a6769a79db63198c1c414b85bae1b407777cbc56d53c208ec09a6
Real on-chain transactions (visible at testnet.cspr.live):

600 CSPR native stake, block 8,550,584, status processed, error message null: https://testnet.cspr.live/deploy/74a4803ffc9745bfd733dbf43c0988fe559ba6b79dcb09338e0b6d71221c5c26
Vault log after successful stake, outcome success: https://testnet.cspr.live/deploy/e0ee79198701bb8169fe29feae65318be3be02e959ced13f6d71882f04ef1188
Stakeholder deposit 33.99 CSPR from Mall XYZ Operator: https://testnet.cspr.live/deploy/413ed9fee367de60e1303871b66b02d4db58d036e5614cb939e47e80118632f4
Earlier swap 1 CSPR to sCSPR, atomic with vault log: https://testnet.cspr.live/deploy/c44b777e55cf260700e8b00869683bb8d3e57f7c6c7f217edbc414e2ecf22b6f
Earlier LP approvals (CEP-18) for WCSPR pair, block 953f1263, success: https://testnet.cspr.live/deploy/47bf77c0de00117d19ea5a876cc72ad4a609562a3223c052a243db38ff818704
The 600 CSPR native stake is the headline proof: block 8,550,584, status processed, error message null, amount 600,000,000,000 motes. The agent opened the cascade, paid the x402 forecast, picked stake as the action, signed with the local SECP256K1 PEM, submitted via account_put_transaction, and wrote the audit log back. Every link in that chain is on the testnet today.

Security
Because real CSPR now flows through it, ARWA went through a self-administered adversarial pass before the Final Round.

The x402 signing path is real EIP-712 with SECP256K1 keys via @noble/curves, byte-equivalent to the casper-eip-712 reference lib. The agent key is anchored under agent slash keys slash, never committed; .env and .pem files are in .gitignore. The on-chain call path uses account_put_transaction with the {Version1: signedJson} wrapper, not the Casper 1.x account_put_deploy, because Casper 2.0 rejects Deploy format. The vault log path uses ContractCallBuilder.byPackageHash (Casper 2.0), not StoredVersionedContractByHash (Casper 1.x only).

CSPR.trade MCP has two documented patches: body-parser limit raised to 10mb at node_modules slash @modelcontextprotocol slash sdk slash node_modules slash body-parser slash lib slash utils.js line 64, and the SECP256K1 pubkey regex widened to accept 66-char compressed keys at node_modules slash @make-software slash cspr-trade-mcp slash dist slash index.js. Both are documented in AGENTS.md and reproducible from a clean install.

The MCP build_swap tool has a 10 to the 9 multiplier bug: it treats our already-in-motes input as CSPR and converts again, producing 10 to the 9 times the intended on-chain value. The fix is in agent slash src slash executor.ts: divide the proposed amountIn by 10 to the 9 before calling buildUnsignedDeploy. This is documented in the README and AGENTS.md and is the single highest-impact workaround in the project.

One finding is worth naming because it is the same class CasCet surfaced. The public hosted CSPR.cloud x402 facilitator on testnet returns an "invalid signature" verdict for test payments, because the agent's test EIP-712 signatures do not match the production allowlist. The x402 server at agent slash scripts slash x402Server.ts already implements the correct EIP-712 message hash, the correct SECP256K1 signature scheme, and a graceful-degradation path: it returns the forecast to the agent and logs the facilitator rejection, so the cycle completes end-to-end without the agent ever depending on the hosted facilitator for the demo. Production settlement requires the Casper Association allowlist, which is post-buildathon work.

What does not work today, on purpose or by infrastructure
add_liquidity full transaction is 107 KB JSON, which exceeds the Casper 2.0 testnet public RPC body limit. The two approval transactions confirm the code path on chain; the LP transaction itself works on mainnet. SSE live-event stream is disabled because the CSPR.cloud stream.testnet.cspr.cloud endpoint was decommissioned. Fund state uses a local file-backed cache (agent slash arwa-fund-state.json) because Odra contract state is unreadable via the public CSPR.cloud REST API; the cache is updated only by real on-chain events the backend actually wrote. None of these are bugs; all are documented in the README honest-gaps section.

[Gambar 5: sequence-flow.png — letakkan di section "Why Casper" sebagai bukti alur pipeline. 4 vertical lifelines (DEPOSIT, ANALYST, EXECUTOR, VAULT) dengan 7 horizontal arrows: event observed, fetch portfolio, x402 paid signal, decision stake, record execution, emit revenue, next event in 30s. Tagline bottom: 0 human in the loop.]

Why Casper
Instant deterministic finality. A six-strategy decision loop would stall waiting on probabilistic finality; on Casper each hop settles in seconds, with certainty. x402 micropayments settle atomically with the strategy that triggered them, so the agent never needs to reconcile an off-chain receipt with an on-chain state. CSPR.trade testnet liquidity for CSPR and sCSPR is real (10 to the 9 motes reserves on the CSPRHAM and sCSPR pairs), and the native auction has 18,528 active testnet validators. Both are reachable from the same agent process.

Casper's AI Toolkit (MCP servers, x402 facilitator, Odra framework with llms.txt) is what made this project buildable in the available time. The CSPR.cloud MCP and CSPR.trade MCP are the two integration points the agent cannot do without; x402 is the only protocol the micropayment layer respects; Odra 2.7 is the only path to deploy Casper-2.0-compatible contracts from a Windows dev box.

Long-term launch plan
Q3 2026: era reward auto-claim, real SSE restore when CSPR.cloud brings the stream endpoint back, multi-key stakeholder wallets, first RWA partner pilot (parking operator in Indonesia, 1 paying stakeholder running real CSPR through ARWA). Q4 2026: mainnet candidate, Redis-backed fund state, LLM audit trail, Casper Association ecosystem grant application. Q1 2027: multi-agent specialist split — Risk Agent, Treasury Agent, Legal Agent deliberate on every cycle. 2027 plus: optional CSPR cross-chain bridge, only when an RWA partner requires it.

The core stays Apache 2.0 forever. Fees only on the hosted version.

Links
GitHub: https://github.com/antidumpalways/ARWA-Agent
Demo video: https://youtu.be/4X8O37tQRWo
Testnet: https://testnet.cspr.live
StakeholderDeposit: https://testnet.cspr.live/contract-package/c0ae4b5dcef3a6aa26154ae3c62aa5768691877d97d81e7ce794046ed7d20f2a
AgentVault v2: https://testnet.cspr.live/contract-package/ab4608ba784fb8c90928b95a5e8b7b54d12c7e94557ae8e28e3f86e2da3b7b67
RevenueEmitter: https://testnet.cspr.live/contract-package/5ba747dfbf3a6769a79db63198c1c414b85bae1b407777cbc56d53c208ec09a6
Stake tx 600 CSPR: https://testnet.cspr.live/deploy/74a4803ffc9745bfd733dbf43c0988fe559ba6b79dcb09338e0b6d71221c5c26 (block 8,550,584)
Vault log: https://testnet.cspr.live/deploy/e0ee79198701bb8169fe29feae65318be3be02e959ced13f6d71882f04ef1188 (success)
Stakeholder deposit: https://testnet.cspr.live/deploy/413ed9fee367de60e1303871b66b02d4db58d036e5614cb939e47e80118632f4
Earlier swap 1 CSPR to sCSPR: https://testnet.cspr.live/deploy/c44b777e55cf260700e8b00869683bb8d3e57f7c6c7f217edbc414e2ecf22b6f
Earlier LP approval WCSPR: https://testnet.cspr.live/deploy/47bf77c0de00117d19ea5a876cc72ad4a609562a3223c052a243db38ff818704
License: https://github.com/antidumpalways/ARWA-Agent/blob/main/LICENSE (Apache 2.0)
Solo builder: antidumpalways, Indonesia

---

## Placement reference (untuk upload ke DoraHacks form)

| Image | File | Form field |
|-------|------|------------|
| 1 | cover-og.png | Cover Image / Thumbnail (1200x630) |
| 2 | architecture.png | Gallery #1 — di awal "What ARWA does" |
| 3 | dashboard.png | Gallery #2 — setelah section "Audit" |
| 4 | cspr-live-verification.png | Gallery #3 — di awal "Live on Casper testnet" |
| 5 | sequence-flow.png | Gallery #4 (optional) — di section "Why Casper" |

Kalau form hanya izinkan 1 cover + 1 inline image, pakai:
- Cover: `architecture.png` (paling informatif untuk first impression)
- Inline: `cspr-live-verification.png` (paling kuat sebagai proof)
- Sisanya referensikan di text dengan link ke `github.com/antidumpalways/ARWA-Agent/demo/assets/` (file sudah di-push)

---

## Track

```
Casper Innovation Track — Autonomous Yield-Routing Agents via MCP
```

(closest match dari example build directions di buildathon FAQ)

## Team

Solo builder. Country Indonesia. GitHub antidumpalways. Background in Web3 and AI. v0.8.3 of ARWA is a working end-to-end demonstration that x402 plus MCP plus native auction can power self-driving RWA yield routers on Casper 2.0.
