import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount } from "./amount";
import { depositFee, previewShares, previewWithdraw } from "./math";
import { anchorErrorName, describeError } from "./errors";

describe("parseAmount", () => {
  it("переводит в минимальные единицы, запятая = точка", () => {
    expect(parseAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseAmount("1,5", 6)).toBe(1_500_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount("7", 6)).toBe(7_000_000n);
  });

  it("не теряет точность на больших суммах (float бы округлил)", () => {
    expect(parseAmount("9007199254.740993", 6)).toBe(9_007_199_254_740_993n);
  });

  it("отклоняет лишние знаки и мусор", () => {
    expect(() => parseAmount("1.0000001", 6)).toThrow();
    expect(() => parseAmount("-1", 6)).toThrow();
    expect(() => parseAmount("1e3", 6)).toThrow();
    expect(() => parseAmount("", 6)).toThrow();
    expect(() => parseAmount("1.", 6)).toThrow();
  });
});

describe("formatAmount", () => {
  it("убирает лишние нули и не теряет мелочь", () => {
    expect(formatAmount(1_500_000n, 6)).toBe("1.5");
    expect(formatAmount(1n, 6)).toBe("0.000001");
    expect(formatAmount(7_000_000n, 6)).toBe("7");
    expect(formatAmount(0n, 6)).toBe("0");
    expect(formatAmount(9_007_199_254_740_993n, 6)).toBe("9007199254.740993");
  });
});

describe("depositFee — комиссия 1%, как DEPOSIT_FEE_BPS в lib.rs", () => {
  it("1% с округлением вниз", () => {
    expect(depositFee(100_000_000n)).toBe(1_000_000n);
    expect(depositFee(50_000_000n)).toBe(500_000n);
    expect(depositFee(99n)).toBe(0n);
  });
});

describe("previewShares — та же формула, что deposit в lib.rs", () => {
  it("первый депозит: shares = сумма минус комиссия", () => {
    expect(previewShares(100_000_000n, 0n, 0n)).toBe(99_000_000n);
  });

  it("A вносит 100, потом B вносит 50 → 49.5 shares", () => {
    expect(previewShares(50_000_000n, 99_000_000n, 99_000_000n)).toBe(49_500_000n);
  });

  it("shares есть, а токенов 0 — контракт тоже даёт shares = net", () => {
    expect(previewShares(1000n, 0n, 100n)).toBe(990n);
  });

  it("делит с округлением вниз", () => {
    expect(previewShares(200n, 3n, 2n)).toBe(132n);
  });

  it("после прибыли vault за те же токены выходит меньше shares", () => {
    expect(previewShares(1000n, 1100n, 1000n)).toBe(900n);
  });
});

describe("previewWithdraw — та же формула, что withdraw в lib.rs", () => {
  it("делит с округлением вниз: 2 * 2 / 3 = 1", () => {
    expect(previewWithdraw(2n, 2n, 3n)).toBe(1n);
  });

  it("после прибыли за shares выходит больше токенов", () => {
    expect(previewWithdraw(100n, 1100n, 1000n)).toBe(110n);
  });

  it("пустой vault — 0", () => {
    expect(previewWithdraw(5n, 0n, 0n)).toBe(0n);
  });
});

describe("describeError", () => {
  it("имя ошибки Anchor из AnchorError и из логов", () => {
    expect(anchorErrorName({ error: { errorCode: { code: "InMarket", number: 6006 } } })).toBe("InMarket");
    expect(
      anchorErrorName({ message: "x", logs: ["Program log: AnchorError ... Error Code: ZeroAmount. Error Number: 6000."] })
    ).toBe("ZeroAmount");
  });

  it("InMarket объясняет паузу, а не показывает код", () => {
    expect(describeError({ error: { errorCode: { code: "InMarket" } } })).toMatch(/в рынке/);
  });

  it("неизвестная ошибка контракта показывает её имя", () => {
    expect(describeError({ error: { errorCode: { code: "WrongPool" } } })).toMatch(/WrongPool/);
  });

  it("ошибки заданий 1–6: минимум, пауза, непустая карточка", () => {
    expect(describeError({ error: { errorCode: { code: "DepositTooSmall" } } })).toMatch(/минимального/);
    expect(describeError({ error: { errorCode: { code: "VaultPaused" } } })).toMatch(/паузе/);
    expect(describeError({ error: { errorCode: { code: "CardNotEmpty" } } })).toMatch(/shares/);
  });

  it("sync_vault не от админа", () => {
    expect(describeError({ error: { errorCode: { code: "Unauthorized" } } })).toMatch(/админ/);
  });

  it("отмена в кошельке", () => {
    expect(describeError({ code: 4001, message: "User rejected the request." })).toMatch(/отменили/);
  });

  it("нет SOL на комиссию", () => {
    expect(
      describeError({ message: "Simulation failed: Attempt to debit an account but found no record of a prior credit." })
    ).toMatch(/SOL/);
  });

  it("лимит RPC", () => {
    expect(describeError({ message: "429 Too Many Requests" })).toMatch(/лимит/);
  });

  it("не дождались подтверждения — предупреждает, что транзакция могла пройти", () => {
    const text = describeError({
      message: "Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed.",
    });
    expect(text).toMatch(/могла пройти/);
    expect(text).not.toMatch(/Попробуйте ещё раз/);
  });

  it("таймаут, в подписи которого есть «429», — всё равно «могла пройти», а не лимит RPC", () => {
    const text = describeError({
      message:
        "Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed. " +
        "Check signature 3wGx429LTg6crH7XjjV4 using the Solana Explorer or CLI tools.",
    });
    expect(text).toMatch(/могла пройти/);
  });

  it("«429» в логах (compute units) — не лимит RPC", () => {
    const text = describeError({ message: "failed", logs: ["Program X consumed 14293 of 200000 compute units"] });
    expect(text).not.toMatch(/лимит/);
  });

  it("истёк blockhash — можно повторить", () => {
    expect(describeError({ message: "Blockhash not found" })).toMatch(/ещё раз/);
  });

  it("ошибка с пустым message не даёт пустой текст", () => {
    expect(describeError({ name: "TokenOwnerOffCurveError", message: "" })).toBe("TokenOwnerOffCurveError");
    expect(describeError({ name: "TokenAccountNotFoundError", message: "" })).toMatch(/vault-config/);
  });

  it("0x1 токен-программы — не хватает токенов, а 0x10 — нет", () => {
    expect(describeError({ message: "failed: custom program error: 0x1" })).toMatch(/токенов/);
    expect(describeError({ message: "failed: custom program error: 0x10" })).not.toMatch(/токенов/);
  });
});
