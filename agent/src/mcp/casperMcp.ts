/**
 * Real MCP client for CSPR.cloud (blockchain queries, balance, contract state).
 *
 * Uses the official @modelcontextprotocol/sdk over Streamable HTTP transport.
 * Authentication via `X-CSPR-Cloud-Api-Key` header.
 *
 * Docs: https://docs.cspr.cloud/agentic-tools/mcp-server
 * Source: https://github.com/msanlisavas/casper-mcp
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../config';

let cached: Client | null = null;
let initPromise: Promise<Client> | null = null;

export async function getCasperMcp(): Promise<Client> {
  if (cached) return cached;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const cfg = loadConfig();
    const transport = new StreamableHTTPClientTransport(new URL(cfg.CSPR_CLOUD_MCP_URL), {
      requestInit: {
        headers: {
          'X-CSPR-Cloud-Api-Key': cfg.CSPR_CLOUD_API_KEY,
        },
      },
    });
    const client = new Client(
      { name: 'parkflow-agent', version: '0.2.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    cached = client;
    return client;
  })();
  return initPromise;
}

export interface CasperAccountInfo {
  publicKey: string;
  balance: string;     // motes
  staked: string;
  delegations: number;
  transfers: number;
}

export async function getAccountInfo(publicKey: string): Promise<CasperAccountInfo> {
  const client = await getCasperMcp();
  const res = await client.callTool({
    name: 'GetAccountBalance',
    arguments: { public_key: publicKey },
  });
  const parsed = parseToolResult(res);
  return {
    publicKey,
    balance: parsed.balance,
    staked: parsed.staked ?? '0',
    delegations: parsed.delegations ?? 0,
    transfers: parsed.transfers ?? 0,
  };
}

export async function getContractState(
  contractHash: string,
  statePath: string[]
): Promise<unknown> {
  const client = await getCasperMcp();
  const res = await client.callTool({
    name: 'GetContractState',
    arguments: { contract_hash: contractHash, state_path: statePath },
  });
  return parseToolResult(res);
}

export async function getRecentRevenueEvents(
  emitterHash: string,
  limit = 20
): Promise<unknown[]> {
  const client = await getCasperMcp();
  const res = await client.callTool({
    name: 'CallContractEntryPoint',
    arguments: {
      contract_hash: emitterHash,
      entry_point: 'get_recent_events',
      args: { limit },
    },
  });
  return parseToolResult(res);
}

export async function getVaultPortfolio(vaultHash: string): Promise<unknown> {
  const client = await getCasperMcp();
  const res = await client.callTool({
    name: 'CallContractEntryPoint',
    arguments: {
      contract_hash: vaultHash,
      entry_point: 'get_portfolio',
      args: {},
    },
  });
  return parseToolResult(res);
}

// MCP tool results come back in { content: [{ type, text }] } form
function parseToolResult(res: any): any {
  if (res?.structuredContent) return res.structuredContent;
  if (Array.isArray(res?.content)) {
    for (const c of res.content) {
      if (c.type === 'text' && typeof c.text === 'string') {
        try { return JSON.parse(c.text); } catch { return c.text; }
      }
    }
  }
  return res;
}
