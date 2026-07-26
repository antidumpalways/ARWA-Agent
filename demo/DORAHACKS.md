# DoraHacks Submission Description — Final Round

> No hashtag (#), no markdown, no bullet characters. Plain text only.

---

## Project Title

```
ARWA — Agentic Real-World Assets
```

## Tagline (max ~120 chars)

```
Autonomous multi-agent RWA yield router on Casper 2.0. Stakeholders deposit, agents route via x402 and CSPR.trade and native auction, every decision on-chain.
```

## Project Description (plain text — copy-paste ready)

ARWA is an autonomous multi-agent RWA yield router built on Casper 2.0 testnet for the Casper Agentic Buildathon 2026 Final Round. Real-world stakeholders (parking operators, rental owners, royalty issuers) deposit CSPR on-chain; an AI agent picks up each deposit, pays a 0.001 CSPR micropayment via the x402 EIP-712 protocol for a premium utilization forecast, and routes the funds through one of six yield strategies including CSPR.trade DEX swaps and Casper native auction delegation. Every decision is signed locally by the agent, submitted to the testnet, and committed back on-chain as a verifiable audit log. No human in the loop. No simulations.

The problem ARWA solves is that real-world revenue is messy. Parking gate receipts, monthly rent, music royalties land in custodial wallets and just sit there. No agent, no routing, no yield. The operator has to log in, evaluate six strategies, sign a transaction, and pray the bridge works. ARWA replaces all of that.

What we built for the Final Round, v0.8.3. Three deployed Odra 2.7 smart contracts on Casper 2.0 testnet. StakeholderDeposit at hash c0ae4b5dcef3a6aa26154ae3c62aa5768691877d97d81e7ce794046ed7d20f2a is the source of funds with per-deposit source label and source kind provenance. AgentVault v2 at hash ab4608ba784fb8c90928b95a5e8b7b54d12c7e94557ae8e28e3f86e2da3b7b67 is the redesigned fund custodian with deposit_for_strategy, record_strategy_execution, record_yield_realised, and withdraw_for_strategy methods. RevenueEmitter at hash 5ba747dfbf3a6769a79db63198c1c414b85bae1b407777cbc56d53c208ec09a6 is the legacy audit log package reused for on-chain emit_revenue calls.

Six strategy actions are all wired end-to-end. swap uses CSPR.trade DEX with the 10 to the 9 multiplier bug worked around in the executor. stake uses the SDK NativeDelegateBuilder against Casper 2.0 native auction with a 500 CSPR minimum guard. add_liquidity and remove_liquidity use CSPR.trade MCP with percentage-based exit. compound re-stakes realised yield. hold short-circuits and writes only an audit log entry. The dashboard has a Force Action toggle so judges can demo any of the six actions on demand.

Decision loop runs as follows. On-chain deposit event from StakeholderDeposit triggers the agent. Analyst reads the event, fetches the agent live portfolio via CSPR.cloud MCP, and quotes a route via CSPR.trade MCP. Agent then pays a micropayment for a premium off-chain utilization signal using the x402 protocol, Casper fork of EIP-712 signed TransferAuthorization. The signal server returns a 402 challenge, agent signs it with its local private key, replays the request, and gets the forecast. LLM (or deterministic heuristic fallback) decides one of six actions with a confidence score. Executor dispatches based on action, signs locally, submits via account_put_transaction RPC. On success the agent records the position in the new AgentVault and writes an audit log entry to the legacy RevenueEmitter.

Real on-chain transactions, all visible on testnet.cspr.live. Stake 600 CSPR native delegation at block 8550584, transaction 74a4803ffc9745bfd733dbf43c0988fe559ba6b79dcb09338e0b6d71221c5c26, status processed, error message null. Stakeholder deposit 413ed9fee367de60e1303871b66b02d4db58d036e5614cb939e47e80118632f4 from Mall XYZ Operator 41.08 CSPR. Stakeholder deposit 0d87a5423612c69681fadde54a16884a9e06394df697e605adcbff61a2fa2e27 from Spotify-Royalty-Q2 6.51 CSPR. Vault log e0ee79198701bb8169fe29feae65318be3be02e959ced13f6d71882f04ef1188 with outcome success. Earlier swap transaction c44b777e55cf260700e8b00869683bb8d3e57f7c6c7f217edbc414e2ecf22b6f 1 CSPR to sCSPR atomic with vault log 5ee46d02fafaca54c0aaa8b12b4f30d124be2e3406e67e12f0e9ae693675e746. Earlier LP approvals at block 953f1263, transactions 47bf77c0de00117d19ea5a876cc72ad4a609562a3223c052a243db38ff818704 and e8e94e8d449d828c83efcf7360cf74f0a1dd12804d25e6cd723b81cb22ac3e13.

Production-grade features. Risk circuit breaker detects greater than 10 percent drawdown or 3 revert streak and auto-trips with 10 minute cooldown, file-backed state in agent slash arwa-risk.json. Multi-pair selector ranks CSPR pairs by analyze_trade plus quote impact plus fee APY, falls back to sCSPR. Min-stake guard refuses to delegate below 500 CSPR with auto-fallback to swap. Fund state cache is a local file-backed authoritative state for AUM yield and positions, updated only by real on-chain events, because Odra contract state is unreadable via CSPR.cloud REST public endpoints. Trigger-driven simulator provides a one-click dashboard button that triggers a stakeholder deposit plus an agent cycle for live demos.

Dashboard at localhost port 3000 with the query string dashboard equals 1. Four cards: Physical World, Agent Identity, On-Chain Record, Fund. Force Action dropdown with six actions. Trigger Deposit and Run Cycle button. Five-step pipeline animation showing agent reasoning in real-time. 30 of 30 jest tests pass, zero TypeScript errors on src, Apache 2.0 license.

Honest gaps. Realised yield is 0 CSPR because testnet era rewards are not yet claimed, planned for v0.9. AUM shows testnet-scale numbers around 1,400 CSPR custodied and 3 positions. add_liquidity full tx is blocked on the testnet RPC body limit but works on mainnet. SSE live-event stream is disabled because the CSPR.cloud stream endpoint was decommissioned, also planned for v0.9. Fund state uses a local cache because Odra struct reads are not supported on public CSPR.cloud REST.

Post-buildathon roadmap, version 0.9 in Q3 2026 adds era reward auto-claim, real SSE restore, and multi-key stakeholder wallets. Version 1.0 in Q4 2026 targets mainnet candidate, Redis-backed fund state, and LLM audit trail. Version 1.1 in Q1 2027 introduces multi-agent specialist split for Risk, Treasury, and Legal agents. Version 1.2 and beyond adds optional cross-chain RWA bridge only when an RWA partner requires it.

The core stays Apache 2.0 forever. Fees only on the hosted version. We are applying for the Casper Association ecosystem grant immediately after the Final Round.

---

## GitHub Repository

```
https://github.com/antidumpalways/ARWA-Agent
```

## Demo Video

```
https://youtu.be/4X8O37tQRWo
```

## Tech Stack (plain text)

Casper 2.0 testnet, Odra 2.7 Rust smart contracts, Node.js 26, TypeScript 5.4, casper-js-sdk v5 with raw TransactionV1 constructor, SECP256K1 PEM signing, x402 EIP-712 micropayments via @noble/curves, CSPR.cloud MCP REST plus JSON-RPC, CSPR.trade MCP self-hosted with body-parser and pubkey regex patches, single-file index.html dashboard with Tailwind CDN and dark theme, Apache 2.0 license, 30 of 30 jest tests pass, zero TypeScript errors on src.

## Track

```
Casper Innovation Track — Autonomous Yield-Routing Agents via MCP
```

(closest match from the example build directions)

## Team

Solo builder. Country Indonesia. GitHub antidumpalways. Background in Web3 and AI. v0.8.3 of ARWA is a working end-to-end demonstration that x402 plus MCP plus native auction can power self-driving RWA yield routers on Casper 2.0.

## Long-Term Launch Plan

12 to 18 month vision. ARWA equals the trust layer for agentic finance on Casper. Every real-world revenue stream should be able to earn yield autonomously 24/7 with no human in the loop and every decision signed on-chain. Phased milestones: v0.9 in Q3 2026 era reward auto-claim plus first RWA partner pilot (parking operator in Indonesia). v1.0 in Q4 2026 mainnet candidate plus Casper Association grant. v1.1 in Q1 2027 multi-agent specialist split. v1.2+ in 2027 plus optional chain-agnostic bridge. Funding path: self-funded plus grant plus 0.5 percent AUM fee plus B2B SaaS. Distribution: Indonesia home market Q3-Q4 2026, SEA expansion Q1-Q2 2027, global 2027+. Success criteria for 12 months: 100,000 plus CSPR AUM on mainnet, 3 plus signed RWA partners, 3 multi-agent specialists live, 1 Casper grant secured, 99.9 percent dashboard uptime, 10,000 plus on-chain audit-log entries, 5,000 plus community followers.
