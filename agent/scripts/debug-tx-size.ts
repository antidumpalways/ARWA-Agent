import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const t = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const c = new Client({ name: 'x', version: '0' }, { capabilities: {} });
  await c.connect(t);
  const r: any = await c.callTool({
    name: 'build_add_liquidity',
    arguments: {
      token_a: 'WCSPR', token_b: 'CSPRCAT',
      amount_a: '1', amount_b: '1',
      sender_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
    },
  });
  const text = r.content[0].text;
  const txs: number[] = [];
  const re = /"hash":"[a-f0-9]{64}"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let p = m.index;
    while (p > 0 && text[p] !== '{') p--;
    if (p > 0) txs.push(p);
  }
  const extractTx = (start: number): string | null => {
    let depth = 0, inStr = false, escape = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    return text.substring(start, end + 1);
  };
  const txStr = extractTx(txs[2])!;
  console.log('Total tx size:', txStr.length, 'bytes');
  const m2 = txStr.match(/"module_bytes":"([a-f0-9]+)"/);
  console.log('Module bytes length:', m2 ? m2[1].length / 2 : 'not found', 'bytes');
  const parsed = JSON.parse(txStr);
  console.log('Top-level keys:', Object.keys(parsed));
  console.log('payload keys:', Object.keys(parsed.payload || {}));
  console.log('fields keys:', Object.keys(parsed.payload?.fields || {}));
  console.log('target keys:', Object.keys(parsed.payload?.fields?.target || {}));
  console.log('approvals:', parsed.approvals);

  // entry_point value
  console.log('entry_point:', parsed.payload?.fields?.entry_point);
  // args.Named first key
  const args = parsed.payload?.fields?.args?.Named;
  if (Array.isArray(args)) {
    console.log('args Named count:', args.length);
    args.slice(0, 3).forEach((a: any) => {
      console.log(`  - ${a[0]}: parsed=${a[1]?.parsed?.slice(0, 60) || a[1]?.parsed}`);
    });
  }
  // target.Session info
  const sess = parsed.payload?.fields?.target?.Session;
  if (sess) {
    console.log('Session.runtime:', sess.runtime);
    console.log('Session.module_bytes length:', sess.module_bytes?.length);
    console.log('Session.is_install_upgrade:', sess.is_install_upgrade);
  }
}

main();