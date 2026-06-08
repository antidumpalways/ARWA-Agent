// Test setup — runs before every test file.
// We disable live network and load required env vars.

process.env.CSPR_CLOUD_API_KEY = process.env.CSPR_CLOUD_API_KEY ?? 'test-cspr-cloud-key';
process.env.CASPER_RPC_URL = process.env.CASPER_RPC_URL ?? 'https://node.testnet.cspr.cloud/rpc';
process.env.CASPER_CHAIN_NAME = process.env.CASPER_CHAIN_NAME ?? 'casper-test';
process.env.X402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://x402-facilitator.cspr.cloud';
process.env.X402_SIGNAL_ENDPOINT = process.env.X402_SIGNAL_ENDPOINT ?? 'http://localhost:4001/signal';
process.env.CSPR_CLOUD_MCP_URL = process.env.CSPR_CLOUD_MCP_URL ?? 'https://mcp.testnet.cspr.cloud/mcp';
process.env.CSPR_TRADE_MCP_URL = process.env.CSPR_TRADE_MCP_URL ?? 'https://mcp.cspr.trade/mcp';
process.env.AGENT_SECRET_KEY_PATH = process.env.AGENT_SECRET_KEY_PATH ?? './keys/agent.test.pem';
process.env.PORT = process.env.PORT ?? '4000';
