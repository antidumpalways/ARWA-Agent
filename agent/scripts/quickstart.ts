/**
 * ARWA — quickstart checker.
 *
 * Runs the verify script in non-strict mode and prints a one-shot checklist
 * of the remaining steps to go from "fresh checkout" to "demo-ready".
 */
import { execSync } from 'child_process';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';

const line = (s = '') => console.log(s);

function head(text: string) {
  line('');
  line(`${BOLD}${BLUE}${text}${RESET}`);
  line(`${BLUE}${'─'.repeat(text.length)}${RESET}`);
}

const CHECKS = [
  {
    title: 'CSPR.cloud API key',
    cmd: 'grep -E "CSPR_CLOUD_API_KEY=.+" .env 2>/dev/null',
  },
  {
    title: 'Testnet CSPR key',
    cmd: 'test -f keys/agent.pem',
  },
  {
    title: 'RevenueEmitter wasm',
    cmd: 'test -f ../contracts/odra/wasm/RevenueEmitter.wasm',
  },
  {
    title: 'AgentVault wasm',
    cmd: 'test -f ../contracts/odra/wasm/AgentVault.wasm',
  },
  {
    title: 'REVENUE_EMITTER_CONTRACT_HASH',
    cmd: 'grep -E "REVENUE_EMITTER_CONTRACT_HASH=hash-.+" .env .env.local 2>/dev/null',
  },
  {
    title: 'AGENT_VAULT_CONTRACT_HASH',
    cmd: 'grep -E "AGENT_VAULT_CONTRACT_HASH=hash-.+" .env .env.local 2>/dev/null',
  },
];

function run(cmd: string): { ok: boolean; out: string } {
  try {
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (e: any) {
    return { ok: false, out: '' };
  }
}

line('');
line(`${BOLD}ARWA — quickstart checklist${RESET}`);

head('Local prerequisites');
for (const c of CHECKS) {
  const r = run(c.cmd);
  const status = r.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  line(`  ${status}  ${c.title}`);
}

head('Steps to demo');
line('  1. ${YELLOW}casper-client keygen keys/agent.pem${RESET}');
line('     Then fund it at ${YELLOW}https://testnet.cspr.live/tools/faucet${RESET}');
line('');
line('  2. Get an API key at ${YELLOW}https://cspr.cloud/${RESET}');
line('     Put it in .env as CSPR_CLOUD_API_KEY=...');
line('');
line('  3. Build the contracts:');
line(`     ${YELLOW}cd contracts/odra && cargo +nightly-2025-01-15 odra build${RESET}`);
line('');
line('  4. Deploy:');
line(`     ${YELLOW}npm run deploy${RESET}   (or \`npm run record -- --revenue=... --vault=...\` if you deployed manually)`);
line('');
line('  5. Ask the Casper Discord for a sponsored x402 facilitator (free during buildathon).');
line(`     Set ${YELLOW}X402_FACILITATOR_URL${RESET} in .env to the URL they give you.`);
line('');
line('  6. Start the stack:');
line(`     ${YELLOW}npm run x402-server${RESET}   (terminal 1)`);
line(`     ${YELLOW}npm run dev${RESET}            (terminal 2)`);
line(`     ${YELLOW}npx serve ../frontend -l 3000${RESET}  (terminal 3)`);
line('');
line('  7. Open ${YELLOW}http://localhost:3000${RESET}, connect CSPR.click, click RUN.');
line('');
line('  8. For the demo video, capture the deploy hashes in https://testnet.cspr.live/deploy/<hash>');
line('');

head('Optional');
line(`  • Set ${YELLOW}LLM_API_KEY${RESET} to use the LLM strategy (defaults to deterministic heuristic).`);
line(`  • Run ${YELLOW}npm run verify -- --strict${RESET} to fail on warnings too.`);
line(`  • See ${YELLOW}SETUP_WINDOWS.md${RESET} for full installation details.`);
line('');
