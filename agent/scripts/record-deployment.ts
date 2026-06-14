/**
 * Manually record contract hashes into `.env.local` after a deploy.
 *
 * Use this if you deployed via the casper client / casper-js-sdk / web UI
 * (rather than `npm run deploy`) and want to wire the hashes into the
 * ARWA Agent's env.
 *
 * Usage:
 *   npm run record -- --revenue=hash-abc --vault=hash-def
 *   npm run record -- --from-file=./deployed.json
 *
 * JSON file format:
 *   { "revenue_emitter": "hash-abc", "agent_vault": "hash-def" }
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(REPO, '..', '.env.local');

const argv = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const a = argv.find(x => x.startsWith(`--${name}=`));
  return a?.split('=')[1];
}

const fromFile = getArg('from-file');
let hashes: { revenue_emitter?: string; agent_vault?: string } = {};

if (fromFile) {
  if (!existsSync(fromFile)) {
    console.error(`[record] file not found: ${fromFile}`);
    process.exit(1);
  }
  hashes = JSON.parse(readFileSync(fromFile, 'utf-8'));
} else {
  const rev = getArg('revenue');
  const vault = getArg('vault');
  if (rev) hashes.revenue_emitter = rev.replace(/^hash-/, '');
  if (vault) hashes.agent_vault = vault.replace(/^hash-/, '');
}

if (!hashes.revenue_emitter && !hashes.agent_vault) {
  console.error('[record] nothing to record. Use --revenue=<hash> --vault=<hash> or --from-file=<path>');
  process.exit(1);
}

const lines: string[] = [
  `# Manually recorded by scripts/record-deployment.ts on ${new Date().toISOString()}`,
];
if (hashes.revenue_emitter) {
  lines.push(`REVENUE_EMITTER_CONTRACT_HASH=hash-${hashes.revenue_emitter.replace(/^hash-/, '')}`);
}
if (hashes.agent_vault) {
  lines.push(`AGENT_VAULT_CONTRACT_HASH=hash-${hashes.agent_vault.replace(/^hash-/, '')}`);
}
lines.push('');

writeFileSync(ENV_PATH, lines.join('\n'), { flag: 'a' });
console.log(`[record] wrote to ${ENV_PATH}`);
console.log(JSON.stringify(hashes, null, 2));
console.log('\n[record] Next: `npm run verify` to confirm both hashes were picked up.');
