/**
 * Debug: print full add_liquidity tx structure to understand JSON format.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PK = '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'arwa', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);

  const r: any = await mcp.callTool({
    name: 'build_add_liquidity',
    arguments: {
      token_a: 'WCSPR',
      token_b: 'CSPRCAT',
      amount_a: '1',
      amount_b: '1',
      sender_public_key: PK,
    },
  });
  const text = r.content?.[0]?.text ?? '';

  // Get last transaction (add_liquidity)
  const hashRegex = /"hash":"[a-f0-9]{64}"/g;
  const positions: number[] = [];
  let m;
  while ((m = hashRegex.exec(text)) !== null) {
    let p = m.index;
    while (p > 0 && text[p] !== '{') p--;
    if (p > 0) positions.push(p);
  }
  const extractTx = (start: number): string | null => {
    let depth = 0, inStr = false, escape = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    return text.substring(start, end + 1);
  };
  const txs: string[] = [];
  for (const p of positions) { const tx = extractTx(p); if (tx) txs.push(tx); }
  console.log('Total txs:', txs.length);
  // Print add_liquidity tx structure (no signature, just structure)
  if (txs.length >= 3) {
    const parsed = JSON.parse(txs[2]);
    console.log('\n=== Add LP tx (top-level keys) ===');
    console.log(Object.keys(parsed));
    console.log('\n=== payload fields ===');
    console.log('keys:', Object.keys(parsed.payload || {}));
    if (parsed.payload?.fields?.target) {
      console.log('target:', JSON.stringify(parsed.payload.fields.target, null, 2).slice(0, 500));
    }
    if (parsed.payload?.fields?.entry_point !== undefined) {
      console.log('entry_point:', JSON.stringify(parsed.payload.fields.entry_point));
    }
    if (parsed.payload?.pricing_mode) {
      console.log('pricing_mode:', JSON.stringify(parsed.payload.pricing_mode));
    }
    // Show approvals
    console.log('approvals:', JSON.stringify(parsed.approvals));
  }
  await mcp.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });