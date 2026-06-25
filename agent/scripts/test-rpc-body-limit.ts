/**
 * Find the empirical RPC body size limit for account_put_transaction.
 * Generate increasingly large dummy bodies and see which ones fail.
 */
import axios from 'axios';

const RPC = 'https://node.testnet.cspr.cloud/rpc';
const API_KEY = '019ea14d-a7a5-744c-91b2-afaf3fafa600';

async function testSize(sizeKB: number) {
  // Build a dummy Version1 tx with N chars in module_bytes
  const filler = '00'.repeat(sizeKB * 512); // 1 KB = 512 hex chars = 256 bytes
  const tx = {
    hash: '0'.repeat(64),
    payload: {
      initiator_addr: { PublicKey: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa' },
      timestamp: '2026-06-23T00:00:00.000Z',
      ttl: '30m',
      chain_name: 'casper-test',
      pricing_mode: { PaymentLimited: { gas_price_tolerance: 1, payment_amount: 1000000000, standard_payment: true } },
      fields: {
        target: { Session: { module_bytes: filler, runtime: 'VmCasperV1', is_install_upgrade: true } },
        entry_point: 'Call',
      },
    },
    approvals: [{ signer: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa', signature: '00'.repeat(128) }],
  };
  const jsonStr = JSON.stringify(tx);
  const req = {
    jsonrpc: '2.0',
    method: 'account_put_transaction',
    params: { transaction: { Version1: jsonStr } },
    id: 1,
  };
  try {
    const resp = await axios.post(RPC, req, {
      headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return { size: jsonStr.length, status: 'OK', msg: resp.data?.error?.message || 'submitted', data: resp.data };
  } catch (e: any) {
    const ax = e.response;
    return {
      size: jsonStr.length,
      status: ax?.status ? `HTTP ${ax.status}` : 'ERR',
      msg: ax?.data?.error?.message || e.message,
      data: ax?.data,
    };
  }
}

async function main() {
  const sizes = [10, 30, 50, 80, 100, 120, 150, 200, 300];
  for (const kb of sizes) {
    const r = await testSize(kb);
    const msg = (r.msg || '').toString().slice(0, 80);
    console.log(`[${kb} KB / ${r.size} bytes] ${r.status}: ${msg}`);
    if (r.data && typeof r.data === 'object') {
      console.log('  Full error data:', JSON.stringify(r.data).slice(0, 200));
    }
    if (r.status === 'OK' || r.status === 'ERR') break;
  }
}

main().catch(console.error);