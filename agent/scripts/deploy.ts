/**
 * Deploy Odra contracts to Casper Testnet and record contract hashes.
 *
 * Steps:
 *   1. `cargo +nightly odra build` (in each contract crate) → wasm artifacts
 *   2. Read wasm from contracts/odra/wasm/
 *   3. Build Deploy (module bytes), sign with the agent's key, submit
 *   4. Wait for execution, capture contract hashes from the WriteContract
 *      transform
 *   5. Write to ../../.env.local (gitignored)
 *
 * User must have:
 *   - Testnet CSPR (faucet: https://testnet.cspr.live/tools/faucet)
 *   - AGENT_SECRET_KEY_PATH pointing to a funded account's PEM
 *   - cargo-odra installed (cargo install cargo-odra --locked)
 *   - rust nightly + wasm32 target (see SETUP_WINDOWS.md)
 *
 * Usage:
 *   npm run deploy                 (builds + deploys both contracts)
 *   npm run deploy -- --skip-build (deploys pre-built wasm)
 *   npm run deploy -- --only=revenue_emitter
 *   npm run deploy -- --only=agent_vault
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import { config } from 'dotenv';
import { HttpHandler, RpcClient, PrivateKey, KeyAlgorithm } from 'casper-js-sdk';
import { buildModuleBytesDeploy, buildContractCallDeploy } from '../src/casper/signer';

config({ path: path.join(__dirname, '..', '.env') });

const REPO = path.resolve(__dirname, '..', '..');
const CONTRACTS_DIR = path.join(REPO, 'contracts', 'odra');
const WASM_DIR = path.join(CONTRACTS_DIR, 'wasm');
const SECRET_KEY = process.env.AGENT_SECRET_KEY_PATH ?? './keys/agent.pem';
const RPC = process.env.CASPER_RPC_URL ?? 'https://node.testnet.cspr.cloud/rpc';
const CHAIN = process.env.CASPER_CHAIN_NAME ?? 'casper-test';
// Gas limits PER contract. Casper 2.0 does NOT refund unused gas, so the
// payment amount = `gas_price * gas_limit` is charged upfront regardless of
// actual consumption. Measured costs on 2026-06-08:
//   RevenueEmitter 247.5 CSPR, AgentVault 274.5 CSPR. 5% buffer for safety.
const GAS_BY_CONTRACT: Record<string, string> = {
  revenue_emitter: '260000000000', // 260 CSPR (was using 247.5)
  agent_vault:     '290000000000', // 290 CSPR (was using 274.5)
};
function gasFor(contract: string): string {
  const g = GAS_BY_CONTRACT[contract];
  if (!g) throw new Error(`no gas limit configured for contract ${contract}`);
  return g;
}

// Args parsing
const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes('--skip-build');
const SKIP_DEPLOY = argv.includes('--skip-deploy');
const ONLY_FLAG = argv.find(a => a.startsWith('--only='));
const ONLY = ONLY_FLAG ? ONLY_FLAG.split('=')[1] : null;

interface DeploySpec {
  /** Display name (e.g. "RevenueEmitter"). */
  name: string;
  /** Lowercase key (e.g. "revenue_emitter") used for env-var names + gas lookup. */
  key: string;
  wasmFile: string;
  args: Array<{ name: string; clType: string; value: any }>;
}

function specFor(contract: string, ownerHex: string): DeploySpec {
  const accountKey = `account-hash-${ownerHex}`;
  // Odra requires 4 `odra_cfg_*` args on every install (see
  // `wasm_parts.rs:138` in odra-macros). On top of that, we pass the
  // user-defined `init(...)` args directly in this same transaction.
  // Odra's macro reads them by Rust parameter name (not by `arg0/arg1/…`).
  const cfgArgs = [
    { name: 'odra_cfg_is_upgrade',            clType: 'bool',   value: 'false' },
    { name: 'odra_cfg_package_hash_key_name', clType: 'string', value: 'ARWA_' + contractName(ownerHex) + '_' + contract },
    { name: 'odra_cfg_allow_key_override',    clType: 'bool',   value: 'true' },
    { name: 'odra_cfg_is_upgradable',         clType: 'bool',   value: 'true' },
  ];
  if (contract === 'revenue_emitter') {
    return {
      name: 'RevenueEmitter',
      key: 'revenue_emitter',
      wasmFile: path.join(WASM_DIR, 'RevenueEmitter.wasm'),
      args: [
        ...cfgArgs,
        { name: 'owner',       clType: 'key',  value: accountKey },
        { name: 'emitter',     clType: 'key',  value: accountKey },
        { name: 'max_history', clType: 'u32',  value: '1024' },
      ],
    };
  }
  if (contract === 'agent_vault') {
    return {
      name: 'AgentVault',
      key: 'agent_vault',
      wasmFile: path.join(WASM_DIR, 'AgentVault.wasm'),
      args: [
        ...cfgArgs,
        { name: 'owner',               clType: 'key',  value: accountKey },
        { name: 'agent',               clType: 'key',  value: accountKey },
        { name: 'max_log_history',     clType: 'u32',  value: '1024' },
        { name: 'min_strategy_amount', clType: 'u256', value: '1000000' },
      ],
    };
  }
  throw new Error(`unknown contract spec: ${contract}`);
}

function contractName(ownerHex: string): string {
  // Short stable identifier derived from the owner pubkey. Per-contract prefix
  // gets added in specFor so a single account can deploy both contracts.
  return ownerHex.slice(0, 8);
}

async function main() {
  if (!existsSync(SECRET_KEY)) {
    throw new Error(
      `Agent key not found at ${SECRET_KEY}. Run \`casper-client keygen ${SECRET_KEY}\` and fund it via the testnet faucet first.`
    );
  }
  if (!existsSync(WASM_DIR)) mkdirSync(WASM_DIR, { recursive: true });

  // Step 1: build (unless skipped)
  if (!SKIP_BUILD) {
    console.log('[deploy] building wasm via `cargo +nightly-2025-01-15 odra build`...');
    try {
      execSync('cargo +nightly-2025-01-15 odra build', {
        cwd: CONTRACTS_DIR,
        stdio: 'inherit',
        shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
      });
    } catch (e: any) {
      // wasm-opt/wasm-strip are post-build optimizations; the .wasm files are
      // already saved before the error. If both artifacts exist, continue.
      const rev = path.join(WASM_DIR, 'RevenueEmitter.wasm');
      const av  = path.join(WASM_DIR, 'AgentVault.wasm');
      if (existsSync(rev) && existsSync(av)) {
        console.log('[deploy] ⚠️  cargo odra build exited with code ' + e?.status + ' (likely wasm-opt/wasm-strip not installed).');
        console.log('[deploy]    .wasm files are already saved; continuing with existing artifacts.');
        console.log('[deploy]    (See SETUP_WINDOWS.md step 5 to install wasm-opt for smaller bytecode.)');
      } else {
        console.error('[deploy] cargo odra build failed and no .wasm files found.');
        console.error('[deploy] See SETUP_WINDOWS.md for the wasm-opt/wasm-strip work-around.');
        throw e;
      }
    }
  } else {
    console.log('[deploy] skipping build (--skip-build)');
  }

  // Step 2: read key (auto-detect algorithm)
  console.log(`[deploy] loading key from ${SECRET_KEY}`);
  const pem = readFileSync(SECRET_KEY, 'utf-8');
  let sk: PrivateKey;
  try {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  } catch {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  }
  const pk = sk.publicKey;
  const ownerHex = pk.accountHash().toHex();
  console.log(`[deploy] agent public key: ${pk.toHex()}`);
  console.log(`[deploy] agent account hash: ${ownerHex}`);

  // Step 3: setup client
  // casper-js-sdk v5 HttpHandler: use 'axios' client (default), not 'fetch'.
  // The 'fetch' client gets HTTP 405 from CSPR.cloud for large put_deploy bodies.
  const handler = new HttpHandler(RPC);
  if (process.env.CSPR_CLOUD_API_KEY) {
    handler.setCustomHeaders({ Authorization: process.env.CSPR_CLOUD_API_KEY });
  }
  const client = new RpcClient(handler);

  // Step 4: deploy in order
  const toDeploy: string[] = ONLY
    ? [ONLY]
    : ['revenue_emitter', 'agent_vault'];

  const results: Record<string, string> = {};
  if (SKIP_DEPLOY) {
    console.log('[deploy] skipping deploy (--skip-deploy), using existing .env.local hashes');
    const envPath = path.join(REPO, '..', '.env.local');
    if (existsSync(envPath)) {
      const env = readFileSync(envPath, 'utf-8');
      const m = (k: string) => {
        const r = new RegExp(`^${k}=(hash-[a-f0-9]+)`, 'm').exec(env);
        return r?.[1];
      };
      const rev = m('REVENUE_EMITTER_CONTRACT_HASH');
      const av  = m('AGENT_VAULT_CONTRACT_HASH');
      if (rev) results['revenue_emitter'] = rev;
      if (av)  results['agent_vault']     = av;
    }
    if (Object.keys(results).length === 0) {
      throw new Error('--skip-deploy but no contract hashes found in .env.local');
    }
  } else {
    for (const contract of toDeploy) {
      const spec = specFor(contract, ownerHex);
      if (!existsSync(spec.wasmFile)) {
        throw new Error(
          `wasm file not found: ${spec.wasmFile}\n` +
          'Run `cargo +nightly-2025-01-15 odra build` in contracts/odra first,\n' +
          'or copy the build_contract wasm manually: see SETUP_WINDOWS.md step 5.'
        );
      }
      console.log(`[deploy] deploying ${spec.name}...`);
      results[contract] = await deployWasm(client, sk, spec, CHAIN);
      console.log(`[deploy]   ${spec.name} (with init args) → ${results[contract]}`);
    }
  }

  // Step 5: record hashes (overwrite previous run's block)
  const envPath = path.join(REPO, '..', '.env.local');
  const lines: string[] = [
    `# Generated by scripts/deploy.ts on ${new Date().toISOString()}`,
  ];
  if (results['revenue_emitter']) {
    lines.push(`REVENUE_EMITTER_CONTRACT_HASH=${results['revenue_emitter']}`);
  }
  if (results['agent_vault']) {
    lines.push(`AGENT_VAULT_CONTRACT_HASH=${results['agent_vault']}`);
  }
  lines.push(`CASPER_NETWORK=${CHAIN === 'casper' ? 'casper' : 'casper-test'}`);
  lines.push('');
  // Read existing file, strip out the previous "# Generated by" block,
  // append our fresh one. Avoids runaway growth across many runs.
  let existing = '';
  if (existsSync(envPath)) {
    existing = readFileSync(envPath, 'utf-8');
    const idx = existing.indexOf('# Generated by');
    if (idx > 0) existing = existing.slice(0, idx);
  }
  writeFileSync(envPath, existing + lines.join('\n'));
  console.log(`\n[deploy] wrote contract hashes to ${envPath}`);
  console.log('\n[deploy] Done. Run `npm run verify` to confirm, then `npm run dev` to start the backend.');
  console.log('[deploy] For the demo video, open each hash in https://testnet.cspr.live/deploy/<hash>');
  console.log(JSON.stringify(results, null, 2));
}

async function deployWasm(
  client: RpcClient,
  sk: PrivateKey,
  spec: DeploySpec,
  chain: string
): Promise<string> {
  const wasmBytes = new Uint8Array(readFileSync(spec.wasmFile));
  const argsMap: Record<string, { clType: string; value: any }> = {};
  spec.args.forEach((a) => { argsMap[a.name] = { clType: a.clType, value: a.value }; });

  const deploy = buildModuleBytesDeploy(wasmBytes, argsMap, chain, gasFor(spec.key));
  deploy.sign(sk);
  const submit: any = await client.putDeploy(deploy);
  // casper-js-sdk v5 returns { apiVersion, deployHash, rawJSON } where
  // `deployHash` is a typed Hash object (with .hashBytes / .toHex()) — NOT a
  // string. We always normalize to a 64-char hex string.
  const deployHash = normalizeHash(submit?.deployHash)
    ?? normalizeHash(submit?.deploy_hash)
    ?? normalizeHash(submit?.hash)
    ?? normalizeHash(submit?.transactionHash);
  if (!deployHash) {
    console.error('  [deploy] submit response:', JSON.stringify(submit));
    throw new Error('putDeploy did not return a deploy hash');
  }
  console.log(`  → submit ${deployHash} (waiting up to 120s for execution...)`);

  // Wait + extract contract hash from the deploy's effects.
  // casper-js-sdk v5's `getDeploy` is broken; use `getTransactionByDeployHash`
  // which returns the new Casper 2.0 "transaction" wrapper.
  //
  // Effect shape (Casper 2.0, deserialized by the SDK):
  //   { key: { type: 0|1|2, ... },     ← typed Key object
  //     kind: {
  //       data: {                     ← ALL effects go through `data`!
  //         Write: { CLValue/Contract/ContractPackage/... }
  //         | AddKeys: [{ name, key }]
  //         | Identity | Prune | ...
  //       }
  //     }
  //   }
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try {
      // SDK expects a 64-char hex string (no `hash-` prefix).
      const bare = deployHash.startsWith('hash-') ? deployHash.slice(5) : deployHash;
      const r: any = await client.getTransactionByDeployHash(bare);
      const ei = r?.executionInfo;
      const execResult = ei?.executionResult;
      if (!execResult) continue;
      const errMsg = execResult.errorMessage;
      const effects: any[] = execResult.effects ?? [];
      for (const e of effects) {
        // All `kind` data lives under `kind.data` in Casper 2.0.
        const inner = e?.kind?.data ?? e?.kind;
        if (!inner) continue;
        // Pattern 1: Write → Contract (preferred — has package hash)
        const w = inner?.Write;
        if (w?.Contract?.contract_package_hash) {
          return w.Contract.contract_package_hash;
        }
        if (w?.ContractPackage?.contract_package_hash) {
          return w.ContractPackage.contract_package_hash;
        }
        // Pattern 2: AddKeys gives us the contract hash directly
        if (Array.isArray(inner?.AddKeys)) {
          for (const entry of inner.AddKeys) {
            const k = entry?.key;
            if (typeof k === 'string' && k.startsWith('hash-')) {
              return k;
            }
          }
        }
      }
      if (errMsg) {
        console.warn(`  ⚠ deploy ${deployHash.slice(0, 12)}… failed: ${errMsg}`);
        return deployHash;
      }
    } catch {
      // not yet ready
    }
  }
  // Fallback: return the deploy hash (caller can manually look it up)
  console.warn(`  ⚠ could not extract contract hash for ${spec.name}; using deploy hash as fallback`);
  return deployHash;
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/** Normalize whatever the SDK gives us as a "hash" into a 64-char hex string. */
function normalizeHash(h: any): string | null {
  if (!h) return null;
  if (typeof h === 'string') {
    return h.startsWith('hash-') ? h.slice(5) : h;
  }
  if (h.hashBytes) {
    return 'hash-' + Buffer.from(h.hashBytes).toString('hex');
  }
  if (typeof h.toHex === 'function') {
    const hex = h.toHex();
    return hex.startsWith('hash-') ? hex.slice(5) : hex;
  }
  return null;
}

/**
 * Submit a `callVersionedContract` deploy against an existing contract.
 * Used for follow-up entry-point calls (not the install — install goes
 * through `buildModuleBytesDeploy`).
 */
async function callEntryPoint(
  client: RpcClient,
  sk: PrivateKey,
  contractHash: string,
  entryPoint: string,
  args: Array<{ name: string; clType: string; value: any }>,
  chain: string
): Promise<string> {
  const argsMap: Record<string, { clType: string; value: any }> = {};
  for (const a of args) argsMap[a.name] = { clType: a.clType, value: a.value };
  const bare = contractHash.startsWith('hash-') ? contractHash.slice(5) : contractHash;
  const deploy = buildContractCallDeploy(bare, entryPoint, argsMap, chain);
  deploy.sign(sk);
  const submit: any = await client.putDeploy(deploy);
  const hash = normalizeHash(submit?.deployHash)
    ?? normalizeHash(submit?.deploy_hash)
    ?? normalizeHash(submit?.hash);
  if (!hash) {
    console.error('  [deploy] call submit response:', JSON.stringify(submit));
    throw new Error(`callEntryPoint did not return a deploy hash`);
  }
  return hash;
}

main().catch(e => { console.error('[deploy] failed:', e); process.exit(1); });
