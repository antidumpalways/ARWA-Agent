/**
 * Build TransactionV1 for contract calls (Casper 2.0 format)
 */
import { readFileSync } from 'fs';
import {
  TransactionV1,
  TransactionV1Payload,
  TransactionTarget,
  TransactionEntryPoint,
  TransactionEntryPointEnum,
  TransactionInvocationTarget,
  ByPackageHashInvocationTarget,
  StoredTarget,
  TransactionRuntime,
  TransactionScheduling,
  Transaction,
  Args,
  CLValue,
  Hash,
  Timestamp,
  Duration,
  InitiatorAddr,
  PricingMode,
  FixedMode,
  PublicKey,
  PrivateKey,
  KeyAlgorithm,
  HttpHandler,
  RpcClient,
} from 'casper-js-sdk';
import { loadConfig } from '../config';

export function buildContractCallTransactionV1(
  contractPackageHash: string,
  entryPoint: string,
  args: Record<string, { clType: string; value: any }>,
  chainName: string,
  paymentMotes = '3000000000'
): TransactionV1 {
  const cfg = loadConfig();
  const { publicKey } = getAgentKeys();

  // Build args
  const txArgs = new Args(new Map<string, CLValue>());
  for (const [name, { clType, value }] of Object.entries(args)) {
    txArgs.insert(name, wrapCLValue(clType, value));
  }

  // Build invocation target (by package hash)
  const pkgHex = contractPackageHash.startsWith('hash-')
    ? contractPackageHash.slice(5)
    : contractPackageHash.replace(/^0x/, '');
  const packageHash = Hash.fromHex(pkgHex);
  
  const invocationTarget = new TransactionInvocationTarget();
  const byPackageHash = new ByPackageHashInvocationTarget();
  byPackageHash.addr = packageHash;
  byPackageHash.version = 1; // Use version 1
  byPackageHash.protocolVersionMajor = null;
  invocationTarget.byPackageHash = byPackageHash;

  // Build stored target with VM V2 runtime
  const storedTarget = new StoredTarget();
  storedTarget.id = invocationTarget;
  storedTarget.runtime = TransactionRuntime.vmCasperV2();

  // Build transaction target
  const target = new TransactionTarget();
  target.stored = storedTarget;

  // Build entry point (custom)
  const entryPointObj = new TransactionEntryPoint(
    TransactionEntryPointEnum.Custom,
    entryPoint
  );

  // Build scheduling (standard/immediate)
  const scheduling = new TransactionScheduling({});

  // Build pricing mode (fixed)
  const pricingMode = new PricingMode();
  const fixedMode = new FixedMode();
  fixedMode.gasPriceTolerance = 1;
  fixedMode.additionalComputationFactor = 0;
  pricingMode.fixed = fixedMode;

  // Build initiator address
  const initiatorAddr = new InitiatorAddr(publicKey);

  // Build payload
  const payload = TransactionV1Payload.build({
    initiatorAddr,
    args: txArgs,
    ttl: new Duration(1_800_000), // 30 minutes
    entryPoint: entryPointObj,
    pricingMode,
    timestamp: new Timestamp(new Date()),
    transactionTarget: target,
    scheduling,
    chainName,
  });

  // Create transaction
  return TransactionV1.makeTransactionV1(payload);
}

// Helper functions from signer.ts
let cachedPrivate: PrivateKey | null = null;
let cachedPublic: PublicKey | null = null;

function getAgentKeys(): { privateKey: PrivateKey; publicKey: PublicKey } {
  if (cachedPrivate && cachedPublic) {
    return { privateKey: cachedPrivate, publicKey: cachedPublic };
  }
  const cfg = loadConfig();
  const pem = readFileSync(cfg.AGENT_SECRET_KEY_PATH, 'utf-8');
  try {
    cachedPrivate = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  } catch {
    cachedPrivate = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  }
  cachedPublic = cachedPrivate.publicKey;
  return { privateKey: cachedPrivate, publicKey: cachedPublic };
}

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
      const b = typeof value === 'string'
        ? value.toLowerCase() === 'true' || value === '1'
        : Boolean(value);
      return CLValue.newCLValueBool(b);
    }
    case 'key': {
      const s = String(value);
      const hex = s.startsWith('account-hash-') ? s.slice('account-hash-'.length) : s.replace(/^0x/, '');
      const { AccountHash, Key } = require('casper-js-sdk');
      const ah = AccountHash.fromString(hex);
      const tag = Buffer.from([0]); // 0 = Key::Account
      const keyBytes = Buffer.concat([tag, Buffer.from(ah.toBytes())]);
      const k = Key.fromBytes(keyBytes);
      const v = new CLValue(require('casper-js-sdk').CLTypeKey);
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

export async function signAndSubmitTransactionV1(tx: TransactionV1): Promise<{ txHash: string; result: any }> {
  const { privateKey } = getAgentKeys();
  const cfg = loadConfig();

  // Sign
  tx.sign(privateKey);

  // Wrap in Transaction (required by RPC client)
  const wrappedTx = Transaction.fromTransactionV1(tx);

  // Submit
  const handler = new HttpHandler(cfg.CASPER_RPC_URL);
  if (cfg.CSPR_CLOUD_API_KEY) {
    handler.setCustomHeaders({ Authorization: cfg.CSPR_CLOUD_API_KEY });
  }
  const client = new RpcClient(handler);

  const submitResult = await client.putTransaction(wrappedTx);
  const txHash = (submitResult as any).transaction_hash?.toHex() || 
                 (submitResult as any).hash?.toHex() || 
                 String(submitResult);

  // Wait for execution
  const result = await client.getTransactionInfo(txHash.replace('hash-', ''), 60000);
  
  return { txHash, result };
}
