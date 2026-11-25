export function parseAmount(input: string, decimals: number): bigint {
  const text = input.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Введите число, например 10 или 2.5");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`Не больше ${decimals} знаков после точки`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function formatAmount(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
