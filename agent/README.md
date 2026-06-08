# ParkFlow Agent (Node)

TypeScript agents + backend bridge for Casper. Replaces the original mock
implementation with real MCP, x402, and on-chain Casper SDK integrations.

## Prerequisites
- Node 20+
- A configured `.env` (see `../.env.example`)
- Funded testnet CSPR key at `AGENT_SECRET_KEY_PATH`
- A `CSPR_CLOUD_API_KEY` from https://cspr.cloud

## Install
```bash
npm install
```

## Scripts
| script | what it does |
|---|---|
| `npm run dev`        | run one full analyst → executor cycle |
| `npm run analyst`    | run the analyst in isolation |
| `npm run executor`   | run the executor on a sample proposal |
| `npm run deploy`     | build & deploy Odra contracts, write contract hashes to `.env` |
| `npm run x402-server`| start the local x402-protected signal server (port 4001) |
| `npm run build`      | tsc → dist/ |
| `npm run typecheck`  | tsc --noEmit |

## Module layout
```
src/
├── index.ts             main cycle orchestration
├── analyst.ts           data gathering + x402 signal
├── executor.ts          build/sign/submit + vault log
├── server.ts            Express backend (port 4000)
├── config.ts            zod-validated env
├── types.ts
├── mcp/
│   ├── casperMcp.ts     CSPR.cloud MCP client
│   └── csprTradeMcp.ts  CSPR.trade MCP client
├── x402/
│   └── client.ts        402 → EIP-712 sign → retry
└── casper/
    ├── signer.ts        local key signer + deploy builders
    └── vaultClient.ts   AgentVault on-chain calls
```

## Notes on the protocol pieces
- **x402 signing** uses `casper-eip-712` (the Casper variant of EIP-712
  typed data). The Casper x402 facilitator expects the signature to
  authorize a `transfer_with_authorization` call on the CEP-18 contract.
- **MCP transports** are Streamable HTTP per the official spec.
  CSPR.cloud requires the `X-CSPR-Cloud-Api-Key` header.
- **Local key signing** uses `casper-js-sdk`; keys are read once and cached
  in memory. The PEM file is never logged or transmitted.
