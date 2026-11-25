export const DEPOSIT_FEE_BPS = 100n;
export const BPS_DENOMINATOR = 10_000n;

export function depositFee(amount: bigint): bigint {
  return (amount * DEPOSIT_FEE_BPS) / BPS_DENOMINATOR;
}

export function previewShares(amount: bigint, totalTokens: bigint, totalShares: bigint): bigint {
  const net = amount - depositFee(amount);
  if (totalShares === 0n || totalTokens === 0n) return net;
  return (net * totalShares) / totalTokens;
}

export function previewWithdraw(shares: bigint, totalTokens: bigint, totalShares: bigint): bigint {
  if (totalShares === 0n) return 0n;
  return (shares * totalTokens) / totalShares;
}
