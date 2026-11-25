import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { ActionForm } from "./components/ActionForm";
import { History } from "./components/History";
import { EXPLORER, TOKEN_MINT, TOKEN_SYMBOL } from "./config";
import { formatAmount } from "./lib/amount";
import { describeError } from "./lib/errors";
import { loadHistory, type HistoryItem } from "./lib/history";
import { depositFee, previewShares, previewWithdraw } from "./lib/math";
import {
  cardPda,
  closeCard,
  connection,
  createCard,
  deposit,
  loadUser,
  loadVault,
  setPaused,
  syncVault,
  userShareAta,
  userTokenAta,
  vaultPda,
  vaultTokensPda,
  watchAccounts,
  withdraw,
  withdrawAll,
  type UserView,
  type VaultView,
} from "./lib/vault";
import {
  connectInjected,
  devWallet,
  hasInjectedWallet,
  onInjectedEvent,
  type BrowserWallet,
} from "./lib/wallet";

const SHARE_DECIMALS = 6;
const MIN_SOL = 0.005;

type Status = { kind: "ok" | "error"; text: string; sig?: string } | null;

const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

export default function App() {
  const [wallet, setWallet] = useState<BrowserWallet | null>(null);
  const [vault, setVault] = useState<VaultView | null | undefined>(undefined);
  const [user, setUser] = useState<UserView | null>(null);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const walletRef = useRef<BrowserWallet | null>(null);
  walletRef.current = wallet;
  const requestId = useRef(0);
  const userChoseWallet = useRef(false);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    const w = walletRef.current;
    const stale = () => id !== requestId.current || walletRef.current !== w;
    try {
      const [v, u] = await Promise.all([loadVault(), w ? loadUser(w.publicKey) : null]);
      if (stale()) return;
      setVault(v);
      setUser(u);
      setLoadError("");
    } catch (e) {
      if (stale()) return;
      setLoadError(describeError(e));
    }
    if (!w) return;
    try {
      const h = await loadHistory(connection, cardPda(w.publicKey));
      if (stale()) return;
      setHistory(h);
      setHistoryError("");
    } catch (e) {
      if (stale()) return;
      setHistoryError(describeError(e));
    }
  }, []);

  useEffect(() => {
    setUser(null);
    setHistory(null);
    setHistoryError("");
    setLoadError("");
    refresh();

    const keys: PublicKey[] = [vaultPda, vaultTokensPda];
    if (wallet) {
      const owner = wallet.publicKey;
      keys.push(owner, cardPda(owner), userTokenAta(owner), userShareAta(owner));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    };
    const unwatch = watchAccounts(keys, onChange);
    return () => {
      clearTimeout(timer);
      unwatch();
    };
  }, [wallet, refresh]);

  useEffect(() => {
    if (!hasInjectedWallet()) return;
    const usingPhantom = () => walletRef.current?.kind === "injected";
    connectInjected(true)
      .then((w) => {
        if (!userChoseWallet.current) setWallet(w);
      })
      .catch(() => {});
    const offAccount = onInjectedEvent("accountChanged", () => {
      if (!usingPhantom()) return;
      connectInjected(true)
        .then((w) => usingPhantom() && setWallet(w))
        .catch(() => usingPhantom() && setWallet(null));
    });
    const offDisconnect = onInjectedEvent("disconnect", () => usingPhantom() && setWallet(null));
    return () => {
      offAccount();
      offDisconnect();
    };
  }, []);

  async function connect(kind: "injected" | "dev") {
    userChoseWallet.current = true;
    setStatus(null);
    try {
      setWallet(import.meta.env.DEV && kind === "dev" ? devWallet() : await connectInjected());
    } catch (e) {
      setStatus({ kind: "error", text: describeError(e) });
    }
  }

  async function disconnect() {
    userChoseWallet.current = true;
    await wallet?.disconnect().catch(() => {});
    setWallet(null);
    setStatus(null);
  }

  async function run(okText: string, send: () => Promise<string>): Promise<boolean> {
    setBusy(true);
    setStatus(null);
    try {
      const sig = await send();
      setStatus({ kind: "ok", text: okText, sig });
      return true;
    } catch (e) {
      console.error(e);
      setStatus({ kind: "error", text: describeError(e) });
      return false;
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const tokenFmt = (raw: bigint) => `${formatAmount(raw, vault?.decimals ?? 6)} ${TOKEN_SYMBOL}`;
  const shareFmt = (raw: bigint) => `${formatAmount(raw, SHARE_DECIMALS)} shares`;

  const marketReason = vault?.inMarket
    ? "Деньги vault сейчас в рынке (swap или позиция Raydium). Внесение и вывод откроются после sync_vault."
    : undefined;
  const depositReason = marketReason ?? (vault?.paused ? "Vault на паузе: админ временно остановил внесение." : undefined);
  const isAdmin = !!wallet && !!vault && wallet.publicKey.equals(vault.admin);

  return (
    <div className="page">
      <header>
        <div>
          <h1>Simple Vault</h1>
          <p className="muted">
            Учебный vault на Solana <span className="badge">devnet</span>
          </p>
        </div>
        <div className="wallet">
          {wallet ? (
            <>
              <button className="ghost" title="Скопировать адрес" onClick={() => navigator.clipboard?.writeText(wallet.publicKey.toBase58())}>
                {wallet.name}: {short(wallet.publicKey.toBase58())}
              </button>
              <button className="ghost" onClick={disconnect}>
                Отключить
              </button>
            </>
          ) : (
            <>
              <button onClick={() => connect("injected")}>Подключить Phantom</button>
              {import.meta.env.DEV && (
                <button className="ghost" onClick={() => connect("dev")}>
                  Тестовый кошелёк
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {status && (
        <div className={`status ${status.kind}`} role="status">
          {status.text}{" "}
          {status.sig && (
            <a href={EXPLORER("tx", status.sig)} target="_blank" rel="noreferrer">
              Транзакция в Explorer
            </a>
          )}
        </div>
      )}
      {loadError && <div className="status error">Не удалось загрузить данные: {loadError}</div>}

      <section className="card">
        <h2>Vault</h2>
        {vault === undefined && !loadError && <p className="muted">Загружаем…</p>}
        {vault === null && (
          <p>
            Vault для токена <code>{short(TOKEN_MINT.toBase58())}</code> ещё не создан. Админ: в корне проекта
            выполните <code>yarn setup-demo</code>.
          </p>
        )}
        {vault && (
          <>
            <dl className="stats">
              <div>
                <dt>Всего в vault</dt>
                <dd>{tokenFmt(vault.totalTokens)}</dd>
              </div>
              <div>
                <dt>Выпущено shares</dt>
                <dd>{shareFmt(vault.totalShares)}</dd>
              </div>
              <div>
                <dt>{vault.inMarket ? "Цена 1 share до выхода в рынок" : "Цена 1 share"}</dt>
                <dd>
                  {vault.totalShares === 0n
                    ? `1 ${TOKEN_SYMBOL}`
                    : tokenFmt(previewWithdraw(10n ** BigInt(SHARE_DECIMALS), vault.totalTokens, vault.totalShares))}
                </dd>
              </div>
              <div>
                <dt>Режим</dt>
                <dd>
                  {vault.inMarket ? (
                    <span className="warn">Деньги в рынке</span>
                  ) : vault.paused ? (
                    <span className="warn">Пауза</span>
                  ) : (
                    "Обычный"
                  )}
                </dd>
              </div>
            </dl>
            <p className="muted small">
              Комиссия депозита 1% · Минимальный депозит {tokenFmt(vault.minDeposit)} · Комиссии из пула за всё время:{" "}
              {formatAmount(vault.totalFeesA, vault.decimals)} A / {vault.totalFeesB.toString()} B (мин. ед.)
            </p>
            <p className="muted small">
              Пара для Raydium: {vault.pairSet ? "задана" : "не задана"} · Позиция в пуле:{" "}
              {vault.positionOpen ? "открыта" : "нет"} · Админ:{" "}
              <a href={EXPLORER("address", vault.admin.toBase58())} target="_blank" rel="noreferrer">
                {short(vault.admin.toBase58())}
              </a>{" "}
              · Vault:{" "}
              <a href={EXPLORER("address", vaultPda.toBase58())} target="_blank" rel="noreferrer">
                {short(vaultPda.toBase58())}
              </a>
            </p>
          </>
        )}
      </section>

      {vault && isAdmin && wallet && (
        <section className="card admin">
          <h2>Панель админа</h2>
          <p className="hint">Видна только кошельку админа vault.</p>
          <div className="actions">
            <div className="action">
              <h3>sync_vault</h3>
              <p className="hint">
                {!vault.pairSet
                  ? "Сначала задайте TOKEN_B (add_pair_token): без него sync_vault не вызвать."
                  : vault.positionOpen
                    ? "Позиция в пуле ещё открыта: сначала close_position."
                    : vault.inMarket
                      ? "Пересчитать total_tokens по балансу vault и снова открыть внесение и вывод."
                      : "Vault не в рынке, но sync_vault можно вызвать: total_tokens станет равен балансу vault."}
              </p>
              <button
                disabled={busy || !vault.pairSet || vault.positionOpen}
                onClick={() => run("sync_vault выполнен.", () => syncVault(wallet, vault.vaultTokenAccountB))}
              >
                {busy ? "Ждём подтверждения…" : "Вызвать sync_vault"}
              </button>
            </div>
            <div className="action">
              <h3>Пауза депозитов</h3>
              <p className="hint">{vault.paused ? "Сейчас внесение остановлено." : "Сейчас внесение открыто."}</p>
              <button
                disabled={busy}
                onClick={() =>
                  run(vault.paused ? "Пауза снята." : "Vault на паузе.", () => setPaused(wallet, !vault.paused))
                }
              >
                {busy ? "Ждём подтверждения…" : vault.paused ? "Снять паузу" : "Поставить на паузу"}
              </button>
            </div>
          </div>
        </section>
      )}

      {vault && (
        <section className="card">
          <h2>Мой счёт</h2>
          {!wallet && <p className="muted">Подключите кошелёк, чтобы вносить и выводить токены.</p>}
          {wallet && !user && <p className="muted">Загружаем…</p>}
          {wallet && user && (
            <>
              <dl className="stats">
                <div>
                  <dt>SOL</dt>
                  <dd>{user.sol.toFixed(4)}</dd>
                </div>
                <div>
                  <dt>{TOKEN_SYMBOL} на кошельке</dt>
                  <dd>{tokenFmt(user.tokens)}</dd>
                </div>
                <div>
                  <dt>Мои shares</dt>
                  <dd>{shareFmt(user.shares)}</dd>
                </div>
                <div>
                  <dt>{vault.inMarket ? "Стоили до выхода в рынок" : "Они стоят сейчас"}</dt>
                  <dd>{tokenFmt(previewWithdraw(user.shares, vault.totalTokens, vault.totalShares))}</dd>
                </div>
              </dl>

              {(user.sol < MIN_SOL || user.tokens === 0n) && (
                <p className="note">
                  Нужны тестовые SOL и {TOKEN_SYMBOL}. Попросите админа выполнить в корне проекта:
                  <br />
                  <code>yarn faucet {wallet.publicKey.toBase58()}</code>
                </p>
              )}

              {!user.card ? (
                <div className="action">
                  <h3>Шаг 1. Карточка</h3>
                  <p className="hint">
                    Карточка — ваш личный аккаунт в vault (PDA). Без неё контракт не примет депозит. Создаётся один
                    раз, стоит ~0.001 SOL ренты.
                  </p>
                  <button
                    disabled={busy || user.sol < MIN_SOL || vault.paused}
                    onClick={() => run("Карточка создана.", () => createCard(wallet))}
                  >
                    {busy ? "Ждём подтверждения…" : "Создать карточку"}
                  </button>
                  {vault.paused && <p className="hint">Пока vault на паузе, новые карточки не создаются.</p>}
                </div>
              ) : (
                <>
                  <p className="muted small">
                    Карточка: внесено {tokenFmt(user.card.deposited)}, shares по карточке {shareFmt(user.card.shares)}
                  </p>
                  <div className="actions" key={wallet.publicKey.toBase58()}>
                    <ActionForm
                      title="Внести"
                      unit={TOKEN_SYMBOL}
                      decimals={vault.decimals}
                      max={user.tokens}
                      busy={busy}
                      blockedReason={depositReason}
                      validate={(a) =>
                        a < vault.minDeposit ? `Минимальный депозит — ${tokenFmt(vault.minDeposit)}` : undefined
                      }
                      submitLabel="Внести"
                      previewOut={(a) => previewShares(a, vault.totalTokens, vault.totalShares)}
                      formatOut={(s, a) => `${shareFmt(s)} (комиссия ${tokenFmt(depositFee(a))})`}
                      onSubmit={(a) => run(`Внесено ${tokenFmt(a)}.`, () => deposit(wallet, a, vault.feeWallet))}
                    />
                    <ActionForm
                      title="Вывести"
                      unit="shares"
                      decimals={SHARE_DECIMALS}
                      max={user.shares}
                      busy={busy}
                      blockedReason={marketReason}
                      submitLabel="Вывести"
                      previewOut={(s) => previewWithdraw(s, vault.totalTokens, vault.totalShares)}
                      formatOut={tokenFmt}
                      onSubmit={(s) => run(`Выведено ${shareFmt(s)}.`, () => withdraw(wallet, s))}
                    />
                  </div>
                  <div className="row extra">
                    <button
                      className="ghost"
                      disabled={busy || !!marketReason || user.shares === 0n}
                      onClick={() => run(`Выведено ${shareFmt(user.shares)}.`, () => withdrawAll(wallet))}
                    >
                      Вывести всё
                    </button>
                    <button
                      className="ghost"
                      disabled={busy || user.card.shares !== 0n}
                      title={user.card.shares !== 0n ? "Сначала выведите все shares" : undefined}
                      onClick={() => run("Карточка закрыта, рента вернулась на кошелёк.", () => closeCard(wallet))}
                    >
                      Закрыть карточку
                    </button>
                  </div>
                </>
              )}

              <History
                items={history}
                error={historyError}
                tokenFmt={tokenFmt}
                shareFmt={shareFmt}
              />
            </>
          )}
        </section>
      )}

      <footer className="muted small">
        Swap и позицию Raydium админ выполняет скриптами и тестами (недели 12–13). Данные обновляются сразу, как только
        меняются аккаунты vault или кошелька.
      </footer>
    </div>
  );
}
