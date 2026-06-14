/**
 * ARWA — pre-flight setup verifier.
 *
 * Checks every external dependency the agent needs at runtime and prints a
 * checklist. Exits with non-zero if anything is wrong.
 *
 * Usage:
 *   npm run verify
 *   npm run verify --strict   (treat warnings as failures)
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import axios from 'axios';
import { loadConfig } from '../src/config';

const STRICT = process.argv.includes('--strict');

type Status = 'ok' | 'warn' | 'fail';
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, status: Status, detail: string) {
  checks.push({ name, status, detail });
}

function bar(status: Status): string {
  return status === 'ok' ? '✅' : status === 'warn' ? '⚠️ ' : '❌';
}

async function checkEnv() {
  const cfg = loadConfig();
  record('CSPR.cloud API key', 'ok', `set (${cfg.CSPR_CLOUD_API_KEY.slice(0, 6)}…)`);

  // Network
  record('Network', 'ok', cfg.CASPER_NETWORK);

  // Contract hashes
  if (!cfg.AGENT_VAULT_CONTRACT_HASH) {
    record(
      'AgentVault contract hash',
      'warn',
      'AGENT_VAULT_CONTRACT_HASH not set — run `npm run deploy` after the contracts are live'
    );
  } else {
    record('AgentVault contract hash', 'ok', cfg.AGENT_VAULT_CONTRACT_HASH);
  }
  if (!cfg.REVENUE_EMITTER_CONTRACT_HASH) {
    record(
      'RevenueEmitter contract hash',
      'warn',
      'REVENUE_EMITTER_CONTRACT_HASH not set'
    );
  } else {
    record('RevenueEmitter contract hash', 'ok', cfg.REVENUE_EMITTER_CONTRACT_HASH);
  }

  // Agent key
  if (existsSync(cfg.AGENT_SECRET_KEY_PATH)) {
    const stat = statSync(cfg.AGENT_SECRET_KEY_PATH);
    record(
      'Agent key file',
      'ok',
      `${cfg.AGENT_SECRET_KEY_PATH} (${stat.size} bytes)`
    );
  } else {
    record(
      'Agent key file',
      STRICT ? 'fail' : 'warn',
      `${cfg.AGENT_SECRET_KEY_PATH} not found — run \`casper-client keygen keys/agent.pem\` then fund via the testnet faucet`
    );
  }
}

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    record('Node version', 'ok', `v${process.versions.node}`);
  } else {
    record('Node version', 'fail', `v${process.versions.node} — need >=18`);
  }
}

async function checkNpmPackages() {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
  );
  const required = Object.keys(pkg.dependencies ?? {});
  for (const dep of required) {
    try {
      // Try require.resolve first (CJS packages).
      require.resolve(dep, { paths: [resolve(__dirname, '..')] });
      record('npm package', 'ok', dep);
    } catch {
      // Fall back: check that the package directory exists (works for
      // ESM-only packages like @modelcontextprotocol/sdk).
      const pkgPath = join(__dirname, '..', 'node_modules', dep);
      if (existsSync(pkgPath)) {
        record('npm package', 'ok', `${dep} (ESM)`);
      } else {
        record('npm package', 'fail', `${dep} not installed`);
      }
    }
  }
}

async function checkCasparRpc() {
  const cfg = loadConfig();
  try {
    const res = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0',
        method: 'info_get_status',
        id: 1,
      },
      { timeout: 5000, headers: { Authorization: cfg.CSPR_CLOUD_API_KEY } }
    );
    if (res.data?.result?.peers_count !== undefined) {
      record('Casper RPC', 'ok', `peers=${res.data.result.peers_count}`);
    } else {
      record('Casper RPC', 'warn', `reachable but unexpected payload: ${JSON.stringify(res.data).slice(0, 120)}`);
    }
  } catch (e: any) {
    record('Casper RPC', 'fail', e.message ?? String(e));
  }
}

async function checkCsprCloudMcp() {
  const cfg = loadConfig();
  try {
    const res = await axios.get(cfg.CSPR_CLOUD_MCP_URL, {
      timeout: 5000,
      headers: { 'X-CSPR-Cloud-Api-Key': cfg.CSPR_CLOUD_API_KEY },
      validateStatus: () => true,
    });
    if (res.status < 500) {
      record('CSPR.cloud MCP', 'ok', `reachable (HTTP ${res.status})`);
    } else {
      record('CSPR.cloud MCP', 'fail', `HTTP ${res.status}`);
    }
  } catch (e: any) {
    record('CSPR.cloud MCP', 'fail', e.message ?? String(e));
  }
}

async function checkCsprCloudStreaming() {
  const cfg = loadConfig();
  // Convert wss:// to https:// to probe the host with a simple HTTP OPTIONS
  // request. A real WS connection is tested at runtime.
  const base = cfg.CASPER_NETWORK === 'casper'
    ? 'https://stream.cspr.cloud'
    : 'https://stream.testnet.cspr.cloud';
  try {
    const res = await axios.get(base, {
      timeout: 5000,
      headers: { Authorization: `Bearer ${cfg.CSPR_CLOUD_API_KEY}` },
      validateStatus: () => true,
    });
    // Any response means the host is up; CSPR.cloud WS doesn't speak HTTP
    // for the URL we hit, so 4xx is still "host reachable".
    if (res.status < 600) {
      record('CSPR.cloud Streaming (WS host)', 'ok', `reachable (HTTP ${res.status})`);
    } else {
      record('CSPR.cloud Streaming (WS host)', 'fail', `HTTP ${res.status}`);
    }
  } catch (e: any) {
    record('CSPR.cloud Streaming (WS host)', 'fail', e.message ?? String(e));
  }
}

async function checkX402Facilitator() {
  const cfg = loadConfig();
  try {
    const res = await axios.get(`${cfg.X402_FACILITATOR_URL}/supported`, {
      timeout: 5000,
      headers: { Authorization: cfg.CSPR_CLOUD_API_KEY },
      validateStatus: () => true,
    });
    if (res.status < 500) {
      record('x402 Facilitator', 'ok', `reachable (HTTP ${res.status})`);
    } else {
      record('x402 Facilitator', 'fail', `HTTP ${res.status}`);
    }
  } catch (e: any) {
    record('x402 Facilitator', 'warn', `cannot probe /supported: ${e.message ?? e}`);
  }
}

async function checkWasmArtifacts() {
  const wasmDir = join(__dirname, '..', '..', 'contracts', 'odra', 'wasm');
  for (const name of ['RevenueEmitter.wasm', 'AgentVault.wasm']) {
    const p = join(wasmDir, name);
    if (existsSync(p)) {
      const buf = readFileSync(p);
      // wasm magic: \0asm
      const ok = buf[0] === 0 && buf[1] === 97 && buf[2] === 115 && buf[3] === 109;
      record('Wasm artifact', ok ? 'ok' : 'fail', `${name} (${buf.length} bytes)`);
    } else {
      record(
        'Wasm artifact',
        STRICT ? 'fail' : 'warn',
        `${name} not found — run \`cargo odra build\` in contracts/odra`
      );
    }
  }
}

async function main() {
  await checkNode();
  await checkNpmPackages();
  await checkEnv();
  await checkWasmArtifacts();
  await checkCasparRpc();
  await checkCsprCloudMcp();
  await checkCsprCloudStreaming();
  await checkX402Facilitator();

  console.log('\nARWA — pre-flight check\n');
  let okCount = 0;
  let warnCount = 0;
  let failCount = 0;
  for (const c of checks) {
    console.log(`  ${bar(c.status)}  ${c.name.padEnd(34)} ${c.detail}`);
    if (c.status === 'ok') okCount++;
    else if (c.status === 'warn') warnCount++;
    else failCount++;
  }
  console.log(
    `\n${okCount} ok · ${warnCount} warn · ${failCount} fail\n`
  );

  if (failCount > 0 || (STRICT && warnCount > 0)) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('verify-setup crashed:', e);
  process.exit(2);
});
