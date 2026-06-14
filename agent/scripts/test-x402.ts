/**
 * Test x402 sign and verify locally
 */
import { spawn } from 'child_process';
import axios from 'axios';
import { payAndFetchViaX402 } from '../src/x402/client';

async function main() {
  // Start x402 server
  console.log('[test] Starting x402 server...');
  const server = spawn('npx', ['tsx', 'scripts/x402Server.ts'], {
    cwd: __dirname + '/..',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (data) => {
    console.log(`[server] ${data.toString().trim()}`);
  });
  server.stderr.on('data', (data) => {
    console.log(`[server-err] ${data.toString().trim()}`);
  });

  // Wait for server to start
  await new Promise(r => setTimeout(r, 4000));

  try {
    console.log('[test] Calling x402 client...');
    const result = await payAndFetchViaX402('http://localhost:4001/signal?lot=test');
    console.log('[test] SUCCESS:', JSON.stringify(result.data, null, 2));
    console.log('[test] Proof:', result.proof);
  } catch (e: any) {
    console.log('[test] ERROR:', e.message);
  } finally {
    server.kill();
  }
}

main().catch(console.error);
