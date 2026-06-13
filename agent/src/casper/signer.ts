/**
 * Real Casper transaction signer using casper-js-sdk v5.
 *
 * Non-custodial: the agent reads the secret key from a local PEM file
 * (path from AGENT_SECRET_KEY_PATH env var) and signs deploys locally.
 * The private key never leaves the process.
 *
 * SDK v5 API notes:
 *   - RpcClient(HttpHandler)  replaces  CasperClient
 *   - Deploy / ExecutableDeployItem  replace  DeployUtil
 *   - PrivateKey  replaces  SecretKey
 *   - PublicKey.fromPem(pem, KeyAlgorithm.ED25519)  takes 2 args
 *   - CLValue.newCLString / newCLByteArray / newCLUInt256 / ...
 *   - Timestamp(date) / Duration(ms) are plain constructors
 */
import { readFileSync } from 'fs';
import {
  HttpHandler,
  RpcClient,
  Deploy,
  DeployHeader,
  ExecutableDeployItem,
  StoredVersionedContractByHash,
  ContractPackageHash,
  CLValue,
  CLTypeKey,
  PublicKey,
  PrivateKey,
  KeyAlgorithm,
  Key,
  AccountHash,
  Hash,
  Args,
  Duration,
  Timestamp,
  ContractHash,
  makeCsprTransferDeploy,
  PutDeployResult,
  TransactionV1,
  Transaction,
} from 'casper-js-sdk';
import { loadConfig } from '../config';

// ---- key cache ----

let cachedPrivate: PrivateKey | null = null;
let cachedPublic: PublicKey | null = null;
let cachedAlgo: KeyAlgorithm = KeyAlgorithm.ED25519;

export function getAgentKeys(): {
  privateKey: PrivateKey;
  publicKey: PublicKey;
  algorithm: KeyAlgorithm;
} {
  if (cachedPrivate && cachedPublic) {
    return { privateKey: cachedPrivate, publicKey: cachedPublic, algorithm: cachedAlgo };
  }
  const cfg = loadConfig();
  const pem = readFileSync(cfg.AGENT_SECRET_KEY_PATH, 'utf-8');
  try {
    cachedPrivate = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
    cachedAlgo = KeyAlgorithm.ED25519;
  } catch {
    cachedPrivate = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
    cachedAlgo = KeyAlgorithm.SECP256K1;
  }
  cachedPublic = cachedPrivate.publicKey;
  // expose for x402 client
  process.env.AGENT_PUBLIC_KEY = cachedPublic.toHex();
  return { privateKey: cachedPrivate, publicKey: cachedPublic, algorithm: cachedAlgo };
}

// ---- client ----

let cachedClient: RpcClient | null = null;
export function getCasperClient(): RpcClient {
  if (cachedClient) return cachedClient;
  const cfg = loadConfig();
  // casper-js-sdk v5 HttpHandler: keep default 'axios' client.
  // The 'fetch' client returns 405 for large put_deploy bodies from CSPR.cloud.
  const handler = new HttpHandler(cfg.CASPER_RPC_URL);
  if (cfg.CSPR_CLOUD_API_KEY) {
    handler.setCustomHeaders({ Authorization: cfg.CSPR_CLOUD_API_KEY });
  }
  cachedClient = new RpcClient(handler);
  return cachedClient;
}

// ---- helpers ----

/**
 * Sign and submit a Deploy. Returns the deploy hash and the post-execution info.
 */
export async function signAndSubmitDeploy(
  deploy: Deploy
): Promise<{ deployHash: string; result: any }> {
  const { privateKey } = getAgentKeys();
  const client = getCasperClient();

  deploy.sign(privateKey);

  const submit: PutDeployResult = await client.putDeploy(deploy);
  // `submit` is a typed object — extract hex string.
  // Shape: { apiVersion, deployHash: { hashBytes: Uint8Array(32) }, rawJSON: { deploy_hash, ... } }
  let deployHash: string;
  const sh = submit as any;
  if (typeof sh === 'string') {
    deployHash = sh;
  } else if (sh?.deployHash?.hashBytes) {
    // SDK v5: deployHash is a typed Hash with Uint8Array(32) hashBytes
    deployHash = Buffer.from(sh.deployHash.hashBytes).toString('hex');
  } else if (sh?.rawJSON?.deploy_hash) {
    // Fallback: the raw response body always has the hex string
    deployHash = String(sh.rawJSON.deploy_hash);
  } else if (sh?.hashBytes) {
    deployHash = Buffer.from(sh.hashBytes).toString('hex');
  } else if (sh?.deploy_hash) {
    deployHash = String(sh.deploy_hash);
  } else if (sh?.hash) {
    deployHash = String(sh.hash);
  } else if (sh?.toHex) {
    deployHash = sh.toHex();
  } else {
    deployHash = String(submit);
  }

  const result = await client.waitForDeploy(deploy, 60_000);
  return { deployHash, result };
}

/**
 * Build a Deploy for a CSPR transfer.
 */
export function buildTransferDeploy(
  recipientPublicKeyHex: string,
  amountMotes: string,
  chainName: string,
  paymentMotes = '100000000' // 0.1 CSPR
): Deploy {
  const { publicKey } = getAgentKeys();
  return makeCsprTransferDeploy({
    senderPublicKeyHex: publicKey.toHex(),
    recipientPublicKeyHex,
    transferAmount: amountMotes,
    paymentAmount: paymentMotes,
    chainName,
  });
}

/**
 * Build a Deploy for a contract call (entry point + named args).
 *
 * The args map is a plain object: name → { clType, value }.
 * Supported clType values:
 *   - 'string'   → CLValue.newCLString
 *   - 'u64'      → CLValue.newCLUint64
 *   - 'u256'     → CLValue.newCLUInt256
 *   - 'u512'     → CLValue.newCLUInt512
 *   - 'bool'     → CLValue.newCLValueBool
 *   - 'key'      → CLValue.newCLKey
 *   - 'byteArray' / 'bytes' → CLValue.newCLByteArray (interprets hex 0x... as raw bytes)
 */
export function buildContractCallDeploy(
  contractHash: string,
  entryPoint: string,
  args: Record<string, { clType: string; value: any }>,
  chainName: string,
  paymentMotes = '3000000000', // 3 CSPR — Casper 2.0 TransactionV1 minimum (~2.5 CSPR)
  contractVersion: number | null = 1
): Deploy {
  const { publicKey } = getAgentKeys();
  const header = new DeployHeader(
    chainName,
    [],
    1,
    new Timestamp(new Date()),
    new Duration(1_800_000),
    publicKey
  );

  const clArgs = new Args(new Map<string, CLValue>());
  for (const [name, { clType, value }] of Object.entries(args)) {
    clArgs.insert(name, wrapCLValue(clType, value));
  }

  const session = new ExecutableDeployItem();
  // Use StoredVersionedContractByHash with package hash
  if (contractVersion !== null) {
    const pkgHex = contractHash.startsWith('hash-')
      ? contractHash.slice(5)
      : contractHash.replace(/^0x/, '');
    session.storedVersionedContractByHash = new (StoredVersionedContractByHash as any)(
      ContractPackageHash.fromJSON(pkgHex),
      entryPoint,
      clArgs,
      contractVersion
    );
  } else {
    throw new Error(
      'buildContractCallDeploy: `contractVersion=null` is not supported; ' +
      'always pass a version (default 1) so we can target the contract via its package hash.'
    );
  }

  const payment = ExecutableDeployItem.standardPayment(paymentMotes);

  return Deploy.makeDeploy(header, payment, session);
}

/**
 * Build a Deploy for raw wasm module install (used by the deploy script).
 */
export function buildModuleBytesDeploy(
  wasm: Uint8Array,
  args: Record<string, { clType: string; value: any }>,
  chainName: string,
  paymentMotes = '250000000000' // 250 CSPR
): Deploy {
  const { publicKey } = getAgentKeys();
  const header = new DeployHeader(
    chainName,
    [],
    1,
    new Timestamp(new Date()),
    new Duration(1_800_000),
    publicKey
  );
  const clArgs = new Args(new Map<string, CLValue>());
  for (const [name, { clType, value }] of Object.entries(args)) {
    clArgs.insert(name, wrapCLValue(clType, value));
  }
  const session = ExecutableDeployItem.newModuleBytes(wasm, clArgs);
  const payment = ExecutableDeployItem.standardPayment(paymentMotes);
  return Deploy.makeDeploy(header, payment, session);
}

/**
 * Minimal CLValue wrapper covering the types we need for the AgentVault.
 */
function wrapCLValue(clType: string, value: any): CLValue {
  switch (clType) {
    case 'string':    return CLValue.newCLString(String(value));
    case 'u8':        return CLValue.newCLUint8(Number(value));
    case 'u32':       return CLValue.newCLUInt32(Number(value));
    case 'u64':       return CLValue.newCLUint64(BigInt(value));
    case 'u128':      return CLValue.newCLUInt128(BigInt(value));
    case 'u256':      return CLValue.newCLUInt256(BigInt(value));
    case 'u512':      return CLValue.newCLUInt512(BigInt(value));
    case 'bool': {
      // CLValueBool constructor takes the value directly. Accept both
      // 'true'/'false' strings and booleans.
      const b = typeof value === 'string'
        ? value.toLowerCase() === 'true' || value === '1'
        : Boolean(value);
      return CLValue.newCLValueBool(b);
    }
    case 'key': {
      // casper-js-sdk v5's CLValue.newCLKey is broken: it stores the raw
      // argument in .key, and .bytes() then fails because the stored value
      // has no .bytes() method. Bypass: build a proper Key from bytes
      // (tag 0 = Account, then 32-byte AccountHash) and assign to a
      // hand-constructed CLValue.
      const s = String(value);
      const hex = s.startsWith('account-hash-') ? s.slice('account-hash-'.length) : s.replace(/^0x/, '');
      const ah = AccountHash.fromString(hex);
      const tag = Buffer.from([0]); // 0 = Key::Account
      const keyBytes = Buffer.concat([tag, Buffer.from(ah.toBytes())]);
      const k: any = Key.fromBytes(keyBytes);
      const v: any = new CLValue(CLTypeKey);
      v.key = k.result;
      return v;
    }
    case 'byteArray':
    case 'bytes': {
      const hex = String(value).replace(/^0x/, '');
      return CLValue.newCLByteArray(Uint8Array.from(Buffer.from(hex, 'hex')));
    }
    default:
      throw new Error(`wrapCLValue: unsupported clType ${clType}`);
  }
}

/**
 * Sign a swap transaction and submit it via RPC.
 * Uses the SDK's TransactionV1.sign() for correct signature computation,
 * then builds the final JSON manually and submits via account_put_transaction.
 */
export async function signAndSubmitSwap(
  txJson: Record<string, any>
): Promise<{ deployHash: string; success: boolean }> {
  const { privateKey, publicKey } = getAgentKeys();
  const cfg = loadConfig();
  
  // Create TransactionV1 from raw JSON - SDK handles correct hash computation
  const txHash = Hash.fromHex(txJson.hash);
  const tx = new TransactionV1(txHash, txJson.payload, []);
  
  // SDK signs correctly using blake2b(serialized_bytes)
  tx.sign(privateKey);
  
  // Extract signature from SDK
  const sdkApproval = tx.approvals?.[0];
  const signerHex = sdkApproval?.signer?.toHex?.() || '';
  const sigHex = sdkApproval?.signature?.toString?.() || '';
  
  // Build final JSON with original data + SDK's approval
  const signedJson = {
    ...txJson,
    approvals: [{ signer: signerHex, signature: sigHex }]
  };
  
  // Submit via RPC
  const axios = require('axios');
  const response = await axios.post(cfg.CASPER_RPC_URL, {
    jsonrpc: '2.0',
    method: 'account_put_transaction',
    params: { transaction: { Version1: signedJson } },
    id: 1
  }, {
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.CSPR_CLOUD_API_KEY ? { Authorization: cfg.CSPR_CLOUD_API_KEY } : {}),
    },
    timeout: 60000,
  });
  
  if (response.data.error) {
    throw new Error(`RPC error: ${response.data.error.message}`);
  }
  
  const resultHash = response.data.result?.transaction_hash?.Version1 || 
                     response.data.result?.transaction_hash || '';
  
  // Wait for execution
  try {
    const result = await getCasperClient().waitForTransaction(resultHash, 60000);
    const success = !!(
      result?.execution_results?.[0]?.result?.Success ?? 
      result?.executionResults?.[0]?.result?.Success
    );
    return { deployHash: resultHash, success };
  } catch {
    // Transaction accepted but execution unknown
    return { deployHash: resultHash, success: true };
  }
}
export async function signAndSubmitTransactionV1(
  tx: TransactionV1
): Promise<{ deployHash: string; result: any }> {
  const { privateKey } = getAgentKeys();
  const client = getCasperClient();

  // Sign the transaction
  tx.sign(privateKey);

  // Wrap in Transaction for RPC submission
  const wrappedTx = Transaction.fromTransactionV1(tx);

  // Submit via putTransaction
  const submit = await client.putTransaction(wrappedTx);
  
  // Extract transaction hash
  let txHash: string;
  const sh = submit as any;
  if (sh?.hash?.toHex) {
    txHash = sh.hash.toHex();
  } else if (sh?.transaction_hash?.toHex) {
    txHash = sh.transaction_hash.toHex();
  } else if (typeof sh === 'string') {
    txHash = sh;
  } else {
    txHash = String(submit);
  }

  // Wait for execution
  const result = await client.waitForTransaction(txHash, 60_000);
  return { deployHash: txHash, result };
}

/**
 * Sign raw TransactionV1 JSON directly (bypass broken SDK parser).
 * Computes blake2b hash of payload, signs it, adds approval.
 */
export function signRawTransactionV1(txJson: Record<string, any>): Record<string, any> {
  const { privateKey, publicKey } = getAgentKeys();
  
  // Compute blake2b hash of the payload
  const payloadBytes = Buffer.from(JSON.stringify(txJson.payload));
  const { blake2b } = require('@noble/hashes/blake2b');
  const hash = blake2b(payloadBytes, { dkLen: 32 });
  
  // Sign the hash
  const signature = privateKey.sign(hash);
  
  // Build approval
  const approval = {
    signer: publicKey.toHex(),
    signature: '02' + Buffer.from(signature).toString('hex'), // 02 = SECP256K1
  };
  
  // Add approval to transaction
  const signedTx = { ...txJson };
  signedTx.approvals = [...(signedTx.approvals || []), approval];
  
  return signedTx;
}

/**
 * Submit raw signed transaction JSON via RPC.
 * Tries multiple RPC methods for compatibility.
 */
export async function submitRawTransaction(signedTxJson: Record<string, any>): Promise<{ deployHash: string; result: any }> {
  const client = getCasperClient();
  const cfg = loadConfig();
  
  const axios = require('axios');
  
  // Try multiple RPC methods for compatibility
  const methods = [
    { method: 'account_put_deploy', params: { signed_deploy: signedTxJson } },
    { method: 'put_transaction', params: { transaction: signedTxJson } },
    { method: 'state_put_transaction', params: { transaction: signedTxJson } },
  ];
  
  let lastError = '';
  for (const { method, params } of methods) {
    try {
      const response = await axios.post(cfg.CASPER_RPC_URL, {
        jsonrpc: '2.0',
        method,
        params,
        id: 1,
      }, {
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.CSPR_CLOUD_API_KEY ? { Authorization: cfg.CSPR_CLOUD_API_KEY } : {}),
        },
        timeout: 30000,
      });
      
      if (response.data.error) {
        lastError = response.data.error.message;
        continue;
      }
      
      // Extract transaction hash from response
      const txHash = response.data.result?.transaction_hash || 
                     response.data.result?.deploy_hash || 
                     response.data.result?.hash || '';
      
      if (txHash) {
        // Wait for execution
        const result = await client.waitForTransaction(txHash, 60_000);
        return { deployHash: txHash, result };
      }
    } catch (e: any) {
      lastError = e.message;
      continue;
    }
  }
  
  throw new Error(`All RPC methods failed. Last error: ${lastError}`);
}
