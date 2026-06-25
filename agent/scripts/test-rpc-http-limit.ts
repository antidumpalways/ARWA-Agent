/**
 * Empirically find HTTP body size limit by sending large HTTP requests
 * (just measure what the RPC endpoint accepts at the HTTP level).
 */
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const RPC = process.env.CASPER_RPC_URL!;
const API_KEY = process.env.CSPR_CLOUD_API_KEY!;

async function main() {
  // Send plain HTTP POST with various body sizes
  // Use a simple chain_get_state_root_hash to test HTTP layer (always valid method)
  const dummy = '00'.repeat(1); // 1 byte hex
  for (const sizeKB of [50, 100, 200, 500, 1000, 2000, 4000]) {
    const padding = '00'.repeat(sizeKB * 512);
    // Build large valid-looking JSON-RPC call (with random invalid params)
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'chain_get_state_root_hash',
      params: [{ test_padding: padding }],
    });
    try {
      const resp = await axios.post(RPC, body, {
        headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
        timeout: 30000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
      });
      console.log(`Size ${sizeKB} KB (${body.length} bytes): HTTP ${resp.status} - ${(resp.data?.error?.message || 'OK').slice(0, 80)}`);
      if (resp.status === 413 || resp.status === 502 || resp.status === 504) break;
    } catch (e: any) {
      console.log(`Size ${sizeKB} KB (${body.length} bytes): EXCEPTION ${e.response?.status || 'NO_STATUS'} - ${(e.response?.data?.error?.message || e.message).slice(0, 100)}`);
      if (e.response?.status === 413) break;
    }
  }
}

main().catch(console.error);