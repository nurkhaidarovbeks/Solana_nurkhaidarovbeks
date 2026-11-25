import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { loadHistory, parseLogs } from "./history";

const PROGRAM = "Program EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu invoke [1]";

describe("parseLogs — разбор логов контракта", () => {
  it("deposit: сумма, комиссия и shares", () => {
    expect(
      parseLogs([
        PROGRAM,
        "Program log: Instruction: Deposit",
        "Program log: Deposit: 100000000 tokens (fee 1000000) -> 99000000 shares (total_tokens=99000000, total_shares=99000000)",
      ])
    ).toEqual({ kind: "deposit", tokens: 100_000_000n, fee: 1_000_000n, shares: 99_000_000n });
  });

  it("withdraw и withdraw_all пишут одинаковый лог", () => {
    expect(
      parseLogs(["Program log: Instruction: WithdrawAll", "Program log: Withdraw: 49000000 shares -> 49000000 tokens (total_tokens=0, total_shares=0)"])
    ).toEqual({ kind: "withdraw", shares: 49_000_000n, tokens: 49_000_000n });
  });

  it("создание и закрытие карточки", () => {
    expect(parseLogs(["Program log: User card created for: 9dxp"])).toEqual({ kind: "create" });
    expect(parseLogs(["Program log: User card closed for: 9dxp"])).toEqual({ kind: "close" });
  });

  it("чужие логи — не операция", () => {
    expect(parseLogs([PROGRAM, "Program log: Instruction: Transfer"])).toBeNull();
  });
});

describe("loadHistory", () => {
  const card = Keypair.generate().publicKey;

  it("пропускает неудачные транзакции и непонятные логи, порядок как в RPC", async () => {
    const connection = {
      getSignaturesForAddress: async () => [
        { signature: "s3", blockTime: 300, err: null },
        { signature: "s2", blockTime: 200, err: { InstructionError: [0, "x"] } },
        { signature: "s1", blockTime: 100, err: null },
        { signature: "s0", blockTime: 50, err: null },
      ],
      getTransactions: async (sigs: string[]) => {
        expect(sigs).toEqual(["s3", "s1", "s0"]);
        return [
          { meta: { logMessages: ["Program log: Withdraw: 5 shares -> 5 tokens (total_tokens=0, total_shares=0)"] } },
          { meta: { logMessages: ["Program log: User card created for: x"] } },
          { meta: { logMessages: ["Program log: something else"] } },
        ];
      },
    } as any;
    expect(await loadHistory(connection, card)).toEqual([
      { signature: "s3", time: 300, kind: "withdraw", shares: 5n, tokens: 5n },
      { signature: "s1", time: 100, kind: "create" },
    ]);
  });

  it("карточки ещё не было — пустая история без лишних запросов", async () => {
    const connection = {
      getSignaturesForAddress: async () => [],
      getTransactions: async () => {
        throw new Error("не должен вызываться");
      },
    } as any;
    expect(await loadHistory(connection, card)).toEqual([]);
  });
});
