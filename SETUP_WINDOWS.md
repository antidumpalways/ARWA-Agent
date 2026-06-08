# Local Setup Guide (Windows / PowerShell)

End-to-end walkthrough to take the ParkFlow Agent from a fresh Windows
checkout to a fully running agent on Casper Testnet.

> **Time estimate**: 30-45 min (most of it is waiting for the faucet and
> the contracts to deploy).

## 0. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 20+ (26 tested) | Agent runtime |
| npm | 10+ | Installs agent deps |
| Git | any | Repo |
| Rust (nightly) | 2025-01-15 | Build Odra contracts |
| wasm target | latest | Casper deploy artifact |
| `wasm-opt` (optional) | latest | Smaller deploys |
| Casper client | 2.x | Keygen + faucet helpers |

### 0.1 Install Rust + nightly toolchain

```powershell
# Download rustup-init and run (defaults are fine — installs stable).
# https://rustup.rs/
Invoke-WebRequest -Uri https://win.rustup.rs/x86_64 -OutFile $env:TEMP\rustup-init.exe
& $env:TEMP\rustup-init.exe -y

# Refresh PATH for the current shell.
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

# Add the nightly toolchain pinned by the project.
rustup toolchain install nightly-2025-01-15
rustup target add wasm32-unknown-unknown --toolchain nightly-2025-01-15

# (Optional) post-build optimizer
# Option A — download binaryen (contains wasm-opt)
$binaryenDir = "$env:USERPROFILE\tools\binaryen"
New-Item -ItemType Directory -Path $binaryenDir -Force | Out-Null
Invoke-WebRequest -Uri "https://github.com/WebAssembly/binaryen/releases/download/version_119/binaryen-version_119-x86_64-windows.tar.gz" -OutFile "$env:TEMP\binaryen.tar.gz"
tar -xzf "$env:TEMP\binaryen.tar.gz" -C $binaryenDir
$env:Path = "$binaryenDir\binaryen-version_119\bin;$env:Path"
wasm-opt --version
```

### 0.2 Install `wasm-strip` (WABT)

```powershell
scoop install wabt        # if you use Scoop
# or download the latest wabt release and add to PATH
```

If you skip this, `cargo odra build` will still produce a working wasm —
it just won't be stripped. We can rebuild later.

### 0.3 Install the Casper client

```powershell
scoop install casper-client
# or pull the official .msi from https://docs.casper.network/workflow/cli
```

Verify:
```powershell
casper-client --version
```

## 1. Project setup

```powershell
git clone <this-repo>
cd parkflow-agent

# Copy the env template
cp .env.example agent\.env

# Install agent deps
cd agent
npm install
```

## 2. Get a Casper Testnet key

```powershell
mkdir keys
casper-client keygen keys/agent.pem
# The output prints your public key in hex. Save it.
```

Go to **https://testnet.cspr.live/tools/faucet** and paste your public key. Wait
~30s for the CSPR to arrive.

Confirm by listing deploys for the account:
```powershell
casper-client list-deploys --node-address https://node.testnet.cspr.cloud/rpc --public-key <your pk hex>
```

## 3. Get a CSPR.cloud API key

Visit **https://cspr.cloud/**, sign up, copy the API key from your dashboard,
and paste it into `agent\.env` as `CSPR_CLOUD_API_KEY=...`.

## 4. Verify your environment

```powershell
cd agent
$env:CSPR_CLOUD_API_KEY = "<your key>"
npm run verify
```

Expected output: 17+ ok, 3 warnings (contract hashes + key file — these
disappear after the next two steps).

## 5. Build the contracts

```powershell
cd ..\contracts\odra
cargo +nightly-2025-01-15 odra build
# → wasm/RevenueEmitter.wasm
# → wasm/AgentVault.wasm
```

If you don't have `wasm-opt` + `wasm-strip`, the build panics at the
optimization step but the wasm files are already in `target/wasm32-…` —
copy them manually to `wasm/`:

```powershell
Copy-Item target\wasm32-unknown-unknown\release\revenue_emitter.wasm wasm\RevenueEmitter.wasm
Copy-Item target\wasm32-unknown-unknown\release\agent_vault.wasm wasm\AgentVault.wasm
```

(Once the tools are installed, `cargo odra build` does this automatically.)

## 6. Deploy

### 6a. With `cargo odra deploy` (requires `odra.toml` networks)
Edit `contracts/odra/Odra.toml`, add:
```toml
[networks.casper-test]
rpc_url = "https://node.testnet.cspr.cloud/rpc"
chain_name = "casper-test"
gas_payment = "250000000000"   # 250 CSPR default
```
Then:
```powershell
cargo +nightly-2025-01-15 odra deploy --network casper-test --contract revenue_emitter
cargo +nightly-2025-01-15 odra deploy --network casper-test --contract agent_vault
```
The contract hashes are appended to `agent\.env` automatically.

### 6b. With the bundled deploy script (more reliable for hackathon)
```powershell
cd ..\agent
$env:CSPR_CLOUD_API_KEY = "<your key>"
$env:AGENT_SECRET_KEY_PATH = "..\keys\agent.pem"
npm run deploy
# After ~30-60s, agent\.env.local is appended with both contract hashes.
```

## 7. Run the stack

Open three terminals:

```powershell
# Terminal 1: x402 signal provider
cd agent
npm run x402-server
# → http://localhost:4001/signal

# Terminal 2: backend bridge
cd agent
npm run dev
# → http://localhost:4000

# Terminal 3: frontend
npx serve ../frontend -l 3000
# → http://localhost:3000
```

Open the frontend in a browser. Install the **CSPR.click** Chrome extension
(https://cspr.click), connect your wallet (the same key you funded), then
click **RUN OPTIMIZATION**.

## 8. Verify on-chain

The backend prints real deploy hashes. Open them in the CSPR.live explorer:
`https://testnet.cspr.live/deploy/<hash>`.

You should see:
1. The `x402` `transfer_with_authorization` (if you set up a paid signal)
2. The strategy deploy (swap / add_liquidity)
3. The `execute_strategy` log deploy on `AgentVault`

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cargo odra build` panics with "program not found" | `wasm-opt` / `wasm-strip` not on PATH. Install or copy the wasm manually (see step 5). |
| `node.exe` complains about `--no-wasm-opt` | Older `cargo-odra` versions may not have the flag. Either upgrade `cargo-odra` or skip optimization. |
| Frontend says "no contract hash" | `AGENT_VAULT_CONTRACT_HASH` missing from `agent\.env`. Re-run `npm run deploy`. |
| `info_get_status` returns 401 | Bad CSPR.cloud API key. Get a fresh one. |
| `odra-macros` complains about `box_patterns` feature | Make sure you use `nightly-2025-01-15` toolchain — the stable compiler rejects it. |
| WASM file is too big (>500 KB) | Install `wasm-opt`, run `wasm-opt --signext-lowering wasm/AgentVault.wasm -o wasm/AgentVault.opt.wasm` |
| 401 from `node.testnet.cspr.cloud` | Some testnet nodes don't accept the `Authorization` header. Use `https://node.testnet.cspr.cloud/rpc` (CSPR.cloud-hosted) instead. |

## Next steps

- See `MIGRATION_NOTES.md` for the full v0.3 changelog.
- See `agent/README.md` for the agent module map.
- See `contracts/odra/README.md` for the contract map.
