/**
 * Deploy CEP-18 token + cep18-test-contract helper to Casper 2.0 testnet.
 *
 * Uses the locally-built wasm (we cloned https://github.com/casper-ecosystem/cep18
 * and built with our pinned toolchain — the v1.2.0 pre-built release
 * doesn't work on Casper 2.0).
 *
 * Outputs:
 *   - cep18_token_contract hash (the deployed token)
 *   - cep18_test_contract hash (the balance/allowance reader)
 *   - Writes them to .env as X402_CEP18_PACKAGE_HASH + CEP18_UTIL_QUERY_HASH
 *
 * Init args (per casper-ecosystem/cep18 quickstart):
 *   cep18.wasm:
 *     name: String
 *     symbol: String
 *     decimals: u8
 *     total_supply: U256
 *   cep18_test_contract.wasm: (none)
 *
 * Usage:
 *   npx tsx scripts/deploy-cep18.ts [--no-write-env] [--supply=100000000000000000]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../src/config';
import {
  getAgentKeys,
  signAndSubmitDeploy,
  buildModuleBytesDeploy,
} from '../src/casper/signer';
import axios from 'axios';

const WASM_DIR = join(__dirname, '..', 'wasm-cep18');

function parseArgs(): { noWriteEnv: boolean; supply: string; skipTest: boolean; onlyTest: boolean } {
  const argv = process.argv.slice(2);
  return {
    noWriteEnv: argv.includes('--no-write-env'),
    supply: (argv.find(a => a.startsWith('--supply='))?.split('=')[1] ?? '100000000000000000'),
    skipTest: argv.includes('--skip-test-contract'),
    onlyTest: argv.includes('--only-test-contract'),
  };
}

async function deployWasm(
  cfg: ReturnType<typeof loadConfig>,
  wasmPath: string,
  args: Record<string, { clType: string; value: any }>,
  gasMotes: string,
  label: string
): Promise<{ deployHash: string; success: boolean; err?: string }> {
  const wasm = new Uint8Array(readFileSync(wasmPath));
  console.log(`[${label}] wasm size: ${wasm.length} bytes`);
  console.log(`[${label}] building deploy with ${Number(gasMotes) / 1e9} CSPR gas...`);

  const deploy = buildModuleBytesDeploy(wasm, args, cfg.CASPER_CHAIN_NAME, gasMotes);
  console.log(`[${label}] signing + submitting...`);
  const { deployHash, result } = await signAndSubmitDeploy(deploy);
  console.log(`[${label}] ✓ deploy hash: ${deployHash}`);

  // Inspect via Casper RPC directly
  let errMsg: string | null = null;
  try {
    const r = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0', id: 1, method: 'info_get_deploy',
        params: { deploy_hash: deployHash },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 10000 }
    );
    errMsg = r.data?.result?.execution_info?.execution_result?.Version2?.error_message;
  } catch (e: any) {
    console.log(`[${label}] could not query deploy: ${e.message?.slice(0, 80)}`);
  }
  const success = errMsg === null;
  console.log(`[${label}] outcome: ${success ? 'SUCCESS' : `REVERTED: ${errMsg}`}`);
  return { deployHash, success, err: errMsg ?? undefined };
}

async function queryNamedKeys(
  cfg: ReturnType<typeof loadConfig>,
  agentAccountHashHex: string
): Promise<{ name: string; key: string }[]> {
  const accountHex = agentAccountHashHex.padStart(64, '0').slice(-64);
  try {
    const r = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0', id: 1, method: 'query_global_state',
        params: { key: `account-hash-${accountHex}`, path: [] },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 10000, validateStatus: () => true }
    );
    return r.data?.result?.stored_value?.Account?.named_keys ?? [];
  } catch {
    return [];
  }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.AGENT_SECRET_KEY_PATH) {
    throw new Error('AGENT_SECRET_KEY_PATH not set');
  }

  const { publicKey } = getAgentKeys();
  // accountHash().toHex() already returns the 32-byte account hash as 64 hex chars
  const accountHashHex = publicKey.accountHash().toHex();
  console.log(`[deploy-cep18] agent account hash: account-hash-${accountHashHex}`);

  const args = parseArgs();

  // Step 1: Deploy main CEP-18 token (skip if --only-test-contract)
  let tokenDeploy: { deployHash: string; success: boolean; err?: string };
  if (!args.onlyTest) {
    console.log('\n=== Step 1: Deploy cep18.wasm (main token) ===\n');
    const tokenPath = join(WASM_DIR, 'cep18.wasm');
    if (!existsSync(tokenPath)) {
      throw new Error(`cep18.wasm not found at ${tokenPath}. Build it first.`);
    }
    const tokenArgs: Record<string, { clType: string; value: any }> = {
      name:         { clType: 'string', value: 'ARWA Token' },
      symbol:       { clType: 'string', value: 'ARWA' },
      decimals:     { clType: 'u8',     value: '9' },
      total_supply: { clType: 'u256',   value: args.supply },
    };
    tokenDeploy = await deployWasm(cfg, tokenPath, tokenArgs, '350000000000', 'cep18');
    if (!tokenDeploy.success) {
      console.log('\n[deploy-cep18] Main token deploy reverted. Aborting.');
      process.exit(1);
    }
  } else {
    tokenDeploy = { deployHash: '(skipped — already deployed)', success: true };
  }

  // Step 2: Deploy test contract (helper)
  let utilDeploy: { deployHash: string; success: boolean; err?: string } | null = null;
  if (!args.skipTest) {
    console.log('\n=== Step 2: Deploy cep18_test_contract.wasm (helper) ===\n');
    const utilPath = join(WASM_DIR, 'cep18_test_contract.wasm');
    if (!existsSync(utilPath)) {
      throw new Error(`cep18_test_contract.wasm not found at ${utilPath}. Build it first.`);
    }
    utilDeploy = await deployWasm(cfg, utilPath, {}, '100000000000', 'cep18_test');
    if (!utilDeploy.success) {
      console.log('\n[deploy-cep18] test contract deploy reverted. Continuing without helper.');
      utilDeploy = null;
    }
  }

  // Step 3: Query NamedKeys
  console.log('\n=== Step 3: Query NamedKeys ===\n');
  console.log('[deploy-cep18] waiting 8s for state finalization...');
  await new Promise(r => setTimeout(r, 8000));

  const namedKeys = await queryNamedKeys(cfg, accountHashHex);
  // The actual named keys set by cep18 v1.2.0 are:
  //   cep18_contract_hash_<NAME>        → contract hash
  //   cep18_contract_package_<NAME>     → package hash
  //   cep18_contract_version_<NAME>     → version URef
  //   cep18_contract_package_access_<NAME> → access URef
  let tokenPkgHash = '';
  let tokenContractHash = '';
  let utilHash = '';
  if (namedKeys.length > 0) {
    console.log(`[deploy-cep18] ${namedKeys.length} named key(s) found on agent account:`);
    for (const k of namedKeys) {
      console.log(`  ${k.name} → ${k.key}`);
      if (k.name.startsWith('cep18_contract_hash_')) {
        tokenContractHash = k.key;
      } else if (k.name.startsWith('cep18_contract_package_') && !k.name.includes('access')) {
        tokenPkgHash = k.key;
      } else if (k.name === 'cep18_test_contract') {
        utilHash = k.key;
      }
    }
  } else {
    console.log('[deploy-cep18] No NamedKeys visible on agent account.');
    console.log('  Check the deploys on testnet.cspr.live to find the contract hashes manually.');
  }

  // We want the package hash for the agent (.env expects the package).
  // X402_CEP18_PACKAGE_HASH should be the contract_package_ hash.
  const tokenHash = tokenPkgHash || tokenContractHash;

  // Step 4: Update .env (unless --no-write-env)
  if (!args.noWriteEnv && (tokenHash || utilHash)) {
    console.log('\n=== Step 4: Update .env ===\n');
    const envPath = join(__dirname, '..', '.env');
    if (existsSync(envPath)) {
      let content = readFileSync(envPath, 'utf-8');
      if (tokenHash) {
        content = content.replace(
          /^X402_CEP18_PACKAGE_HASH=.*$/m,
          `X402_CEP18_PACKAGE_HASH=${tokenHash}`
        );
        console.log(`[deploy-cep18] wrote X402_CEP18_PACKAGE_HASH=${tokenHash}`);
      }
      if (utilHash) {
        // Add CEP18_UTIL_QUERY_HASH if not present
        if (content.match(/^CEP18_UTIL_QUERY_HASH=/m)) {
          content = content.replace(
            /^CEP18_UTIL_QUERY_HASH=.*$/m,
            `CEP18_UTIL_QUERY_HASH=${utilHash}`
          );
        } else {
          content += `\nCEP18_UTIL_QUERY_HASH=${utilHash}\n`;
        }
        console.log(`[deploy-cep18] wrote CEP18_UTIL_QUERY_HASH=${utilHash}`);
      }
      writeFileSync(envPath, content);
      console.log(`[deploy-cep18] ✓ .env updated at ${envPath}`);
    } else {
      console.log(`[deploy-cep18] .env not found at ${envPath}, skipping auto-update`);
    }
  }

  console.log('\n=== Summary ===\n');
  console.log(`Token deploy:  ${tokenDeploy.deployHash}`);
  console.log(`Helper deploy: ${utilDeploy?.deployHash ?? '(skipped or reverted)'}`);
  console.log(`Token hash:     ${tokenHash || '(query NamedKeys needed)'}`);
  console.log(`Helper hash:    ${utilHash || '(query NamedKeys needed)'}`);
  console.log(`\nVerify on:`);
  console.log(`  https://testnet.cspr.live/deploy/${tokenDeploy.deployHash}`);
}

main().catch(e => {
  console.error('deploy-cep18 crashed:', e);
  process.exit(1);
});
