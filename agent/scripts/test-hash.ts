/**
 * Try various canonical payload serializations to match MCP hash.
 */
import { blake2b } from '@noble/hashes/blake2b';
import { readFileSync } from 'fs';

function sortKeysRecursive(obj: any): any {
  if (Array.isArray(obj)) return obj.map(sortKeysRecursive);
  if (obj !== null && typeof obj === 'object') {
    const sorted: any = {};
    Object.keys(obj).sort().forEach(k => { sorted[k] = sortKeysRecursive(obj[k]); });
    return sorted;
  }
  return obj;
}

const file = process.argv[2];
const expectedHash = process.argv[3];
if (!file || !expectedHash) {
  console.log('Usage: tsx test-hash.ts <file> <expected_hash>');
  process.exit(1);
}

const tx = JSON.parse(readFileSync(file, 'utf-8'));
const payload = tx.payload;

// Try various serialization approaches
const variants = {
  'JSON.stringify (insertion)': JSON.stringify(payload),
  'JSON.stringify sorted': JSON.stringify(sortKeysRecursive(payload)),
  'no spaces sorted': JSON.stringify(sortKeysRecursive(payload)).replace(/\s/g, ''),
  'JSON.stringify(no indent)': JSON.stringify(payload, null, 0),
  'serialize payload.args sorted': JSON.stringify({
    initiator_addr: payload.initiator_addr,
    timestamp: payload.timestamp,
    ttl: payload.ttl,
    pricing_mode: payload.pricing_mode,
    chain_name: payload.chain_name,
    fields: payload.fields,
  }),
};

// Try various byte interpretations
console.log(`Expected: ${expectedHash}\n`);
for (const [name, str] of Object.entries(variants)) {
  const bytes = new TextEncoder().encode(str);
  const hash = Buffer.from(blake2b(bytes, { dkLen: 32 })).toString('hex');
  const match = hash === expectedHash ? '✓ MATCH' : '✗';
  console.log(`${match}  ${name}: ${hash.slice(0, 16)}...`);
}