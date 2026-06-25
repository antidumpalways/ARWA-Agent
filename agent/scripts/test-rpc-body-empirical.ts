/**
 * Empirically find RPC body limit by submitting progressively larger VALID
 * Version1 transfers (native CSPR transfers — small but valid).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm, Hash, TransactionV1 } from 'casper-js-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const RPC = process.env.CASPER_RPC_URL!;
const SECRET_KEY = process.env.AGENT_SECRET_KEY_PATH!;
const API_KEY = process.env.CSPR_CLOUD_API_KEY!;
const PK = '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa';
const RECV_PK = '0202069116934ee34f70f70bf020dcb3aed1b89e8da387b5fb03db8664661101f'; // random test pk

async function main() {
  // Use MCP to get native transfer template
  const t = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await mcp.connect(t);

  // Get a small native CSPR transfer as template
  console.log('Building small CSPR transfer template...');
  const r: any = await mcp.callTool({
    name: 'get_quote',  // try other tool, no swap needed
    arguments: { token_in: 'CSPR', token_out: 'sCSPR', amount: '1', type: 'exact_in' },
  });
  console.log('quote OK');

  // Build a native transfer using CSPR.trade MCP doesn't have direct transfer
  // Use a dummy tx with valid structure but no module_bytes
  // Actually let's measure the HTTP layer limit by sending large valid tx
  // Casper 2.0 limits transaction size in chainspec

  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);

  // Build a fake native transfer with large args to test
  // CSPR.transfer (native) uses target.Transfer
  const buildTransfer = (extraBytes: number) => {
    // Build a minimal but valid Version1 transaction for native transfer
    const argsBytes = '00'.repeat(extraBytes);
    return {
      hash: '0'.repeat(64),
      payload: {
        initiator_addr: { PublicKey: PK },
        timestamp: new Date().toISOString(),
        ttl: '30m',
        chain_name: 'casper-test',
        pricing_mode: { PaymentLimited: { gas_price_tolerance: 1, payment_amount: 100000000, standard_payment: true } },
        fields: {
          args: { Named: [['amount', { cl_type: 'U512', bytes: '0500e1f505' }]] },
          target: { Transfer: { args: { Named: [] } } },  // simple Transfer to self
          entry_point: 'Call',
        },
      },
      approvals: [],
    };
  };

  // Send progressively larger transactions
  for (const size of [50_000, 100_000, 150_000, 200_000, 250_000, 500_000, 1_000_000, 2_000_000]) {
    const tx = buildTransfer(size);
    const json = JSON.stringify(tx);
    try {
      const resp = await axios.post(RPC, {
        jsonrpc: '2.0', method: 'account_put_transaction',
        params: { transaction: { Version1: json } }, id: 1,
      }, {
        headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
        timeout: 30000,
        maxBodyLength: Infinity, maxContentLength: Infinity,
      });
      const err = resp.data?.error?.message;
      console.log(`Size ${size} bytes (${json.length} bytes): ${err || 'OK'}`);
    } catch (e: any) {
      console.log(`Size ${size} bytes (${json.length} bytes): EXCEPTION ${e.response?.status} - ${(e.response?.data?.error?.message || e.message).slice(0, 100)}`);
    }
  }

  await mcp.close();
}

main().catch(console.error);