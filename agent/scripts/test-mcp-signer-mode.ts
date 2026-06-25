/**
 * Test: use CSPR.trade MCP submit_transaction with the EXACT unsigned JSON
 * from build_add_liquidity (no manual signing needed).
 *
 * This relies on the MCP server to:
 * 1. Compute correct hash from the canonical payload
 * 2. Sign the transaction with its signer
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PK = '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await mcp.connect(transport);

  // First try: build_add_liquidity with optional sender_private_key param to let
  // the MCP server sign for us
  console.log('=== Approach 1: build_add_liquidity with private key ===');
  try {
    const r: any = await mcp.callTool({
      name: 'build_add_liquidity',
      arguments: {
        token_a: 'WCSPR', token_b: 'CSPRCAT',
        amount_a: '1', amount_b: '1',
        sender_public_key: PK,
        sender_private_key: 'NOT_AVAILABLE',  // placeholder, will fail
      },
    });
    console.log((r.content?.[0]?.text ?? '').slice(0, 500));
  } catch (e: any) {
    console.log('Approach 1 error:', e.message?.slice(0, 200));
  }

  // Second try: check if MCP submit_transaction has a "build_and_sign" or
  // similar combined tool
  console.log('\n=== Available tools ===');
  const tools = await mcp.listTools();
  for (const t of tools.tools) {
    if (t.name.includes('sign') || t.name.includes('submit') || t.name.includes('add')) {
      console.log(`- ${t.name}`);
    }
  }

  // Third try: call build_add_liquidity and pipe through local signer if available
  // The local signer mode in CSPR.trade MCP is only available when running with --signer flag
  console.log('\n=== Check if MCP server is in signer mode ===');
  try {
    const tools = await mcp.listTools();
    const hasSign = tools.tools.some(t => t.name === 'sign_deploy');
    console.log('Has sign_deploy tool:', hasSign);
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 200));
  }

  // Fourth approach: use the file-deploy-input feature
  console.log('\n=== Try build_add_liquidity with file_deploy_input enabled ===');
  console.log('(This requires CSPR_TRADE_ENABLE_FILE_DEPLOY_INPUT=true in MCP server)');

  await mcp.close();
}

main().catch(e => console.error('FAIL:', e.message));