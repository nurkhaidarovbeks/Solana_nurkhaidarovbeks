import type { Connection, PublicKey } from "@solana/web3.js";

export type HistoryKind = "deposit" | "withdraw" | "create" | "close";

export interface HistoryItem {
  signature: string;
  time: number | null;
  kind: HistoryKind;
  tokens?: bigint;
  fee?: bigint;
  shares?: bigint;
}

const DEPOSIT = /Program log: Deposit: (\d+) tokens \(fee (\d+)\) -> (\d+) shares/;
const WITHDRAW = /Program log: Withdraw: (\d+) shares -> (\d+) tokens/;
const CREATE = /Program log: User card created for:/;
const CLOSE = /Program log: User card closed for:/;

export function parseLogs(logs: string[]): Omit<HistoryItem, "signature" | "time"> | null {
  for (const line of logs) {
    let m = line.match(DEPOSIT);
    if (m) return { kind: "deposit", tokens: BigInt(m[1]), fee: BigInt(m[2]), shares: BigInt(m[3]) };
    m = line.match(WITHDRAW);
    if (m) return { kind: "withdraw", shares: BigInt(m[1]), tokens: BigInt(m[2]) };
    if (CREATE.test(line)) return { kind: "create" };
    if (CLOSE.test(line)) return { kind: "close" };
  }
  return null;
}

export async function loadHistory(connection: Connection, card: PublicKey, limit = 20): Promise<HistoryItem[]> {
  const signatures = (await connection.getSignaturesForAddress(card, { limit }, "confirmed")).filter((s) => !s.err);
  if (signatures.length === 0) return [];
  const txs = await connection.getTransactions(
    signatures.map((s) => s.signature),
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
  );
  const items: HistoryItem[] = [];
  txs.forEach((tx, i) => {
    const parsed = tx?.meta?.logMessages ? parseLogs(tx.meta.logMessages) : null;
    if (parsed) items.push({ signature: signatures[i].signature, time: signatures[i].blockTime ?? null, ...parsed });
  });
  return items;
}
