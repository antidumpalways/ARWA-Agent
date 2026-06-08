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
  Args,
  Duration,
  Timestamp,
  ContractHash,
  makeCsprTransferDeploy,
  PutDeployResult,
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
  const deployHash =
    (submit as any).deploy_hash ??
    (submit as any).hash ??
    (submit as any).transactionHash ??
    String(submit);

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
  // The deploy.ts flow extracts the **package** hash from the install
  // effects. To call an entry point on a freshly-installed contract, we
  // therefore need `StoredVersionedContractByHash(packageHash, version, ...)`
  // — not `StoredContractByHash`, which wants a 32-byte contract hash that
  // we don't have in hand. The version defaults to 1 (the only version a
  // brand-new package has).
  if (contractVersion !== null) {
    // SDK v5 signature: `new StoredVersionedContractByHash(hash, entryPoint, args, version)`.
    // The version defaults to 1 for a brand-new package.
    // `ContractPackageHash.fromJSON(hex)` is the only working factory — the
    // public constructor is incomplete and `toBytes` fails on it.
    // The .d.ts type says it wants a `ContractHash`, but the runtime
    // accepts a `ContractPackageHash`; the cast is safe.
    session.storedVersionedContractByHash = new (StoredVersionedContractByHash as any)(
      ContractPackageHash.fromJSON(contractHash),
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
