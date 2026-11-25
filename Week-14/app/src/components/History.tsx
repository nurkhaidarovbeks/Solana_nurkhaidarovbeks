import { EXPLORER } from "../config";
import type { HistoryItem } from "../lib/history";

interface Props {
  items: HistoryItem[] | null;
  error: string;
  tokenFmt: (raw: bigint) => string;
  shareFmt: (raw: bigint) => string;
}

const KIND_TEXT: Record<HistoryItem["kind"], string> = {
  deposit: "Внесение",
  withdraw: "Вывод",
  create: "Карточка создана",
  close: "Карточка закрыта",
};

const timeText = (time: number | null) => (time ? new Date(time * 1000).toLocaleString("ru-RU") : "—");

export function History({ items, error, tokenFmt, shareFmt }: Props) {
  function details(item: HistoryItem): string {
    if (item.kind === "deposit") {
      return `${tokenFmt(item.tokens!)} → ${shareFmt(item.shares!)}, комиссия ${tokenFmt(item.fee!)}`;
    }
    if (item.kind === "withdraw") return `${shareFmt(item.shares!)} → ${tokenFmt(item.tokens!)}`;
    return "";
  }

  return (
    <div className="history">
      <h3>История</h3>
      {error && <p className="hint bad">Не удалось загрузить историю: {error}</p>}
      {!error && items === null && <p className="hint">Загружаем…</p>}
      {!error && items?.length === 0 && <p className="hint">Операций пока нет.</p>}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Когда</th>
              <th>Что</th>
              <th>Сумма</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.signature}>
                <td>{timeText(item.time)}</td>
                <td>{KIND_TEXT[item.kind]}</td>
                <td>{details(item)}</td>
                <td>
                  <a href={EXPLORER("tx", item.signature)} target="_blank" rel="noreferrer">
                    Explorer
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
