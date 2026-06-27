// Shared types for ARWA

export interface RevenueEvent {
  timestamp: number;
  amount: string;        // raw motes as string (U256 safe)
  asset: string;         // contract package hash, or zero-address for CSPR
  source: string;        // e.g. "parking-lot-42"
  emitter: string;
  reference: string;     // off-chain reference id
}

export interface Quote {
  amountIn: string;
  amountOut: string;
  priceImpact: string;
  route: string[];
  minReceived: string;
  pair: string;
  expiresAt: number;
}

export interface StrategyProposal {
  action: 'swap' | 'add_liquidity' | 'remove_liquidity' | 'compound' | 'stake';
  pair: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;       // motes
  minAmountOut: string;   // motes (with slippage)
  rationale: string;
  confidence: number;     // 0..100
  x402Proof: X402Proof | null;
  revenueEvent: RevenueEvent;
  /** Validator pubkey when action === 'stake' */
  validatorPubKey?: string;
}

export interface X402Proof {
  paymentHeader: string;     // X-Payment value sent with retry
  settleTxHash: string;      // deploy hash of the on-chain payment
  facilitator: string;
  amountMotes: string;
  asset: string;
  signedAt: number;
}

export interface ExecutionResult {
  txHash: string;
  outcome: 'success' | 'reverted';
  blockHash?: string;
  costMotes?: string;
}

export interface AgentVaultLog {
  action: string;
  amountIn: string;
  amountOut: string;
  /** Display name for the token (e.g. "CSPR"), kept in `pair` for context. */
  tokenIn: string;
  tokenOut: string;
  /** Optional on-chain `Key` for the token. Defaults to the zero address. */
  tokenInHex?: string;
  tokenOutHex?: string;
  pair: string;
  txHash: string;
  x402Proof: string;
  /** Optional on-chain `Key` for the x402 payer. Defaults to the zero address. */
  x402Signer: string;
  x402SignerHex?: string;
  outcome: string;
}
