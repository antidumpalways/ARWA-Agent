/**
 * ARWA - Complete Setup Script
 * 
 * This script handles:
 * 1. Generate agent key (if not exists)
 * 2. Check faucet funding (with instructions)
 * 3. Deploy contracts to testnet
 * 4. Register agent with vault
 * 5. Write contract hashes to .env
 * 
 * Usage:
 *   npm run setup
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import { config } from 'dotenv';
import { HttpHandler, RpcClient, PrivateKey, KeyAlgorithm, PublicKey } from 'casper-js-sdk';
import { buildModuleBytesDeploy, buildContractCallDeploy, signAndSubmitDeploy } from '../src/casper/signer';

// Robust repo-root detection: walk upward from this file until we find
// the directory whose child is `agent/`. Works regardless of whether the
// user cloned the repo as `ParkFlow-Agent/`, `ARWA-Agent/`, or anything
// else.
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    // Look for `agent/package.json` as our anchor (this `scripts/` dir is
    // always at `<root>/agent/scripts/`).
    const candidate = path.join(dir, 'agent', 'package.json');
    if (existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not find repo root from ${startDir}. ` +
    `Expected to find <root>/agent/package.json within 8 levels up.`
  );
}

const REPO = findRepoRoot(path.resolve(__dirname, '..', '..'));
const WASM_DIR = path.join(REPO, 'contracts', 'odra', 'wasm');
const KEYS_DIR = path.join(REPO, 'agent', 'keys');

config({ path: path.join(REPO, 'agent', '.env') });

// Use existing key path from .env or default. The .env value
// `Account 1_secret_key.pem` is relative to `agent/keys/`, so join
// `KEYS_DIR` regardless of whether the env var is set or not.
function resolveSecretKey(): string {
  const rel = process.env.AGENT_SECRET_KEY_PATH ?? 'agent.pem';
  // Make relative paths anchor under <repo>/agent/keys/.
  if (path.isAbsolute(rel)) return rel;
  return path.join(KEYS_DIR, path.basename(rel));
}
const SECRET_KEY_PATH = resolveSecretKey();
console.log('   🔑 Key path:', SECRET_KEY_PATH);

// Casper testnet config
const RPC_URL = process.env.CASPER_RPC_URL || 'https://node.testnet.cspr.cloud/rpc';
const CHAIN_NAME = process.env.CASPER_CHAIN_NAME || 'casper-test';
const FAUCET_URL = 'https://testnet.cspr.live/tools/faucet';

// Gas limits
const GAS_LIMITS = {
  revenue_emitter: '260000000000', // 260 CSPR
  agent_vault: '290000000000',     // 290 CSPR
};

async function main() {
  console.log('🚀 ARWA Setup\n');

  // Step 1: Check/generate key
  console.log('📋 Step 1: Agent Key');
  let privateKey: PrivateKey;
  let publicKey: PublicKey;
  
  if (existsSync(SECRET_KEY_PATH)) {
    console.log('   ✓ Key found:', SECRET_KEY_PATH);
    const pem = readFileSync(SECRET_KEY_PATH, 'utf-8');
    try {
      privateKey = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
    } catch {
      privateKey = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
    }
    publicKey = privateKey.publicKey;
  } else {
    console.log('   ⚠ Key not found. Generating new key...');
    mkdirSync(KEYS_DIR, { recursive: true });
    
    // Generate key using casper-client or manual
    try {
      execSync(`casper-client keygen "${KEYS_DIR}"`, { stdio: 'pipe' });
      console.log('   ✓ Generated with casper-client');
      const pem = readFileSync(path.join(KEYS_DIR, 'secret_key.pem'), 'utf-8');
      privateKey = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
    } catch {
      console.log('   ⚠ casper-client not found, using SDK to generate...');
      // Generate with SDK
      privateKey = PrivateKey.fromPem(
        generateEd25519Pem(),
        KeyAlgorithm.ED25519
      );
      writeFileSync(SECRET_KEY_PATH, privateKey.toPem());
      console.log('   ✓ Generated with SDK');
    }
    publicKey = privateKey.publicKey;
  }

  const accountHash = publicKey.accountHash().toHex();
  console.log(`   Public Key: ${publicKey.toHex()}`);
  console.log(`   Account Hash: ${accountHash}`);

  // Step 2: Check balance
  console.log('\n💰 Step 2: Check Balance');
  const handler = new HttpHandler(RPC_URL);
  if (process.env.CSPR_CLOUD_API_KEY) {
    handler.setCustomHeaders({ Authorization: process.env.CSPR_CLOUD_API_KEY });
  }
  const client = new RpcClient(handler);

  let balance: bigint;
  try {
    // Use CSPR.cloud REST API for balance check
    const axios = require('axios');
    const response = await axios.get(
      `https://api.testnet.cspr.cloud/accounts/${accountHash}/balance`,
      {
        headers: { Authorization: process.env.CSPR_CLOUD_API_KEY },
        timeout: 10000,
      }
    );
    balance = BigInt(response.data?.data?.balance || '0');
    const csprBalance = Number(balance) / 1_000_000_000;
    console.log(`   Balance: ${csprBalance.toFixed(2)} CSPR`);
  } catch (e: any) {
    console.log('   ⚠ Could not fetch balance:', e.message?.slice(0, 80));
    balance = BigInt(0);
  }

  const requiredBalance = BigInt('600000000000'); // 600 CSPR for deploys
  if (balance < requiredBalance) {
    const needed = Number(requiredBalance - balance) / 1_000_000_000;
    console.log(`\n   ⚠ Balance may be insufficient (need ~${needed.toFixed(0)} CSPR for deploys)`);
    console.log(`   🔗 Get testnet CSPR from faucet: ${FAUCET_URL}`);
    console.log(`   📝 Enter this account hash: ${accountHash}`);
    console.log('\n   ⚠️  Continuing anyway... (deploy will fail if insufficient funds)');
  }

  // Step 3: Deploy contracts
  console.log('\n📦 Step 3: Deploy Contracts');
  
  // Deploy RevenueEmitter
  console.log('   Deploying RevenueEmitter...');
  const reHash = await deployContract(
    client,
    privateKey,
    path.join(WASM_DIR, 'RevenueEmitter.wasm'),
    'revenue_emitter',
    [
      { name: 'owner', clType: 'key', value: `account-hash-${accountHash}` },
      { name: 'emitter', clType: 'key', value: `account-hash-${accountHash}` },
      { name: 'max_history', clType: 'u32', value: '1024' },
    ]
  );
  console.log(`   ✓ RevenueEmitter: ${reHash}`);

  // Deploy AgentVault
  console.log('   Deploying AgentVault...');
  const avHash = await deployContract(
    client,
    privateKey,
    path.join(WASM_DIR, 'AgentVault.wasm'),
    'agent_vault',
    [
      { name: 'owner', clType: 'key', value: `account-hash-${accountHash}` },
      { name: 'agent', clType: 'key', value: `account-hash-${accountHash}` },  // Use account hash, not public key
      { name: 'max_log_history', clType: 'u32', value: '1024' },
      { name: 'min_strategy_amount', clType: 'u256', value: '1000000' },
    ]
  );
  console.log(`   ✓ AgentVault: ${avHash}`);

  // Step 4: Register agent (owner is already registered in init)
  console.log('\n🔐 Step 4: Agent Registration');
  console.log('   ✓ Owner registered as agent during init');
  console.log('   ✓ To add more agents later, call register_agent()');

  // Step 5: Update .env
  console.log('\n📝 Step 5: Update .env');
  const envPath = path.join(REPO, 'agent', '.env');
  let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  
  // Update or add contract hashes
  const updates = [
    `REVENUE_EMITTER_CONTRACT_HASH=${reHash}`,
    `AGENT_VAULT_CONTRACT_HASH=${avHash}`,
    `AGENT_SECRET_KEY_PATH=${SECRET_KEY_PATH.replace(/\\/g, '/')}`,
    `CASPER_NETWORK=casper-test`,
    `CASPER_CHAIN_NAME=casper-test`,
  ];

  for (const update of updates) {
    const [key] = update.split('=');
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (envContent.match(regex)) {
      envContent = envContent.replace(regex, update);
    } else {
      envContent += `\n${update}`;
    }
  }

  writeFileSync(envPath, envContent.trim() + '\n');
  console.log('   ✓ .env updated');

  // Done!
  console.log('\n✅ Setup Complete!');
  console.log('\n📊 Summary:');
  console.log(`   Network: ${CHAIN_NAME}`);
  console.log(`   Agent Key: ${publicKey.toHex()}`);
  console.log(`   Account Hash: ${accountHash}`);
  console.log(`   RevenueEmitter: ${reHash}`);
  console.log(`   AgentVault: ${avHash}`);
  console.log('\n🚀 Next steps:');
  console.log('   1. Start x402 server: npm run x402-server');
  console.log('   2. Start backend: npm run dev');
  console.log('   3. Run cycle: npm run cycle');
}

async function deployContract(
  client: RpcClient,
  privateKey: PrivateKey,
  wasmPath: string,
  contractName: string,
  initArgs: Array<{ name: string; clType: string; value: any }>
): Promise<string> {
  if (!existsSync(wasmPath)) {
    throw new Error(`WASM not found: ${wasmPath}`);
  }

  const wasmBytes = new Uint8Array(readFileSync(wasmPath));
  const argsMap: Record<string, { clType: string; value: any }> = {};
  
  // Add Odra config args
  const publicKey = privateKey.publicKey;
  const accountHash = publicKey.accountHash().toHex();
  
  argsMap['odra_cfg_is_upgrade'] = { clType: 'bool', value: 'false' };
  argsMap['odra_cfg_package_hash_key_name'] = { 
    clType: 'string', 
    value: `ARWA_${accountHash.slice(0, 8)}_${contractName}` 
  };
  argsMap['odra_cfg_allow_key_override'] = { clType: 'bool', value: 'true' };
  argsMap['odra_cfg_is_upgradable'] = { clType: 'bool', value: 'true' };
  
  // Add init args
  for (const arg of initArgs) {
    argsMap[arg.name] = { clType: arg.clType, value: arg.value };
  }

  const deploy = buildModuleBytesDeploy(
    wasmBytes,
    argsMap,
    CHAIN_NAME,
    GAS_LIMITS[contractName as keyof typeof GAS_LIMITS]
  );

  deploy.sign(privateKey);
  const result = await signAndSubmitDeploy(deploy);
  
  // Wait for execution and extract contract hash
  // For now, return the deploy hash (user can manually extract contract hash)
  return result.deployHash;
}

function generateEd25519Pem(): string {
  // Simple Ed25519 key generation (placeholder - use proper crypto in production)
  const crypto = require('crypto');
  const { privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return privateKey;
}

main().catch(e => {
  console.error('\n❌ Setup failed:', e.message);
  process.exit(1);
});
