# Simple Vault — практика Anchor

Учебный контракт на Anchor 0.31.1 (Solana). Сейчас он делает четыре вещи, а на неделе 11 к нему добавляется скрипт для Raydium:

1. **Vault создан** — админ создаёт vault для SPL-токена. *(неделя 8)*
2. **У каждого пользователя своя «карточка»** — личный аккаунт (PDA) внутри vault. *(неделя 8)*
3. **Депозит и share-токены** — пользователь вносит токены и получает share-токены. *(неделя 9)*
4. **CPI и вывод** — пользователь возвращает share-токены и забирает свои токены. *(неделя 10)*

5. **Свои токены и свой CLMM-пул на Raydium (devnet)** — скрипт `create-pool`, сам контракт на этой неделе не меняется. *(неделя 11)*

Контракт будет дорабатываться (swap и позиции через Raydium), поэтому он намеренно небольшой.

---

## Что делает контракт

```
initialize_vault    создаёт VaultState PDA, vault token account и share mint
create_user_card    создаёт UserCard PDA — личную карточку пользователя в vault
deposit(amount)     переводит токены пользователя в vault → печатает ему shares
withdraw(shares)    сжигает shares пользователя → отправляет ему токены из vault
withdraw_all        сжигает все shares пользователя за один вызов
close_user_card     закрывает пустую карточку (shares = 0) и возвращает ренту
set_paused(paused)  админ останавливает или возобновляет депозиты
```

### `initialize_vault`

Вызывает админ (платит за аккаунты). Передаёт `fee_wallet` — токен-аккаунт (того же `token_mint`), куда идёт комиссия.
Создаёт три аккаунта для выбранного `token_mint`:

| Аккаунт | Seeds | Что хранит |
|---|---|---|
| `vault_state` | `["vault", token_mint]` | admin, token_mint, адреса token account и share mint, `total_tokens`, `total_shares`, bump, `fee_wallet`, `min_deposit`, `paused` |
| `vault_token_account` | `["vault_tokens", token_mint]` | токен-аккаунт, владелец — vault PDA |
| `share_mint` | `["share_mint", token_mint]` | mint для shares (6 decimals), authority — vault PDA |

### `create_user_card`

Вызывает любой пользователь (платит за свою карточку). Создаёт `UserCard`:

| Поле | Описание |
|---|---|
| `vault` | к какому vault относится карточка |
| `owner` | владелец карточки |
| `deposited` | сколько токенов пользователь сейчас держит в vault (растёт при депозите, уменьшается при выводе) |
| `shares` | сколько share-токенов он получил и ещё не вернул |
| `bump` | bump PDA |

Seeds: `["user_card", vault_state, user]` — поэтому у одного пользователя в одном vault
может быть **только одна** карточка. Повторный вызов завершится ошибкой.

### `deposit(amount)`

Пользователь вносит `amount` токенов и получает share-токены — «квитанции» с его долей в vault.
**Депозит возможен только после `create_user_card`** — без карточки инструкция вернёт ошибку.

Что происходит по шагам:

1. Проверяется, что vault не на паузе и `amount >= min_deposit`.
2. Считается комиссия 1%: `fee = amount × 100 / 10000`, в vault идёт `net = amount − fee`.
3. Считается, сколько shares положено пользователю (от `net`).
4. `fee` переводится на `fee_wallet`, `net` — в `vault_token_account`.
5. Vault печатает shares на share-аккаунт пользователя (подписывает сам vault PDA).
6. Обновляются `total_tokens` и `total_shares` в vault, а также `deposited` и `shares` в карточке.

**Формула shares:**

```
Первый депозит:       shares = net                         (1:1)
Последующие депозиты: shares = net × total_shares / total_tokens
```

Пример: A вносит 100 токенов → 1 токен комиссии, 99 shares. Потом B вносит 50 → 0.5 комиссии, 49.5 shares.
В vault 148.5 токенов и 148.5 shares, у A доля 2/3, у B — 1/3. На `fee_wallet` 1.5 токена.

Минимальный депозит — 1 токен (`min_deposit = 10^decimals`, задаётся в `initialize_vault`).

Ошибки: `ZeroAmount` (сумма 0), `DepositTooSmall` (меньше `min_deposit`), `VaultPaused` (vault на паузе),
`WrongFeeWallet` (передан не тот `fee_wallet`), `SharesTooSmall` (shares вышло бы 0), `MathOverflow`.

### `withdraw(shares_amount)`

Обратная операция: пользователь возвращает `shares_amount` share-токенов и забирает свои токены.
Как и депозит, вывод работает только с карточкой.

**Формула:** `tokens = shares × total_tokens / total_shares`

Что происходит по шагам:

1. Считается, сколько токенов положено за эти shares.
2. **CPI в Token program (`burn`)** — shares пользователя сжигаются. Подписывает сам пользователь.
3. **CPI в Token program (`transfer`)** — токены уходят из `vault_token_account` пользователю.
   Подписывает **vault PDA**: у него нет приватного ключа, программа подписывает за него
   с помощью seeds (`invoke_signed`, в Anchor — `CpiContext::new_with_signer`).
4. Обновляются `total_tokens` и `total_shares` в vault и поля карточки.

Пример: в vault 150 токенов и 150 shares. A возвращает 50 shares → получает 50 токенов.
В vault остаётся 100 токенов и 100 shares.

Вывод работает и во время паузы — пауза останавливает только депозиты.

> **Что такое CPI.** Cross-Program Invocation — один контракт вызывает другой.
> В `deposit` и `withdraw` наш контракт вызывает Token program (`transfer`, `mint_to`, `burn`).
> Когда нужна подпись PDA, вызов делается «с подписью» через seeds — это и есть главная идея недели 10.

Ошибки: `ZeroAmount` (0 shares), `VaultEmpty` (в vault нет shares), `WithdrawTooSmall`
(за такие shares вышло бы 0 токенов), `MathOverflow`. Если shares у пользователя меньше,
чем он хочет вернуть, упадёт сам `burn` (Token program).

Для вызова `deposit` и `withdraw` нужны: токен-аккаунт пользователя (с токенами vault) и share-аккаунт пользователя
(для share mint), для `deposit` ещё `fee_wallet` из `vault_state`. В тестах они создаются через `createAccount` из `@solana/spl-token`.

### `withdraw_all`

То же, что `withdraw`, но количество shares берётся из share-аккаунта пользователя целиком.
Если shares нет — `ZeroAmount`. Аккаунты те же, что у `withdraw`.

### `close_user_card`

Вызывает владелец карточки. Работает только если `shares = 0` в карточке (иначе `CardNotEmpty`).
Карточка закрывается (`close = user`), рента возвращается владельцу. Обычный сценарий: `withdraw_all` → `close_user_card`.

### `set_paused(paused)`

Вызывает только админ vault (иначе `Unauthorized`). Пока `paused = true`, `deposit` возвращает `VaultPaused`.

---

## Неделя 11 — свои токены и свой CLMM-пул на Raydium

### Идея простыми словами

- **AMM** (automated market maker) — пул, в котором два токена лежат вместе, а цена считается по формуле. Обмен идёт прямо с пулом, без биржевого стакана.
- **Концентрированная ликвидность (CLMM)** — поставщик ликвидности не раскидывает деньги по всем ценам от 0 до бесконечности, а выбирает **ценовой диапазон**. Деньги работают только пока цена внутри диапазона, зато комиссий в нём зарабатывается больше.
- На этой неделе мы только **создаём** пул: два наших токена и пул Raydium CLMM на devnet. Позиции и swap будут на следующих неделях.

### Что делает скрипт

`scripts/create-clmm-pool.ts`:

1. Создаёт два тестовых SPL-токена (`TOKEN_A`, `TOKEN_B`, по 6 decimals) и минтит по 1 000 000 каждого на твой кошелёк.
2. Берёт из API Raydium (devnet) конфиг комиссий (шаг тика 60, комиссия 0.25%).
3. Создаёт пул `TOKEN_A / TOKEN_B` в программе Raydium CLMM со стартовой ценой 1 (1 `TOKEN_A` = 1 `TOKEN_B`).
4. Сохраняет адреса в `devnet-pool.json` (файл в `.gitignore`: у каждого студента свои токены и пул).

### Запуск

Нужен баланс на devnet (хватит ~1 SOL) и настроенный `solana config set --url devnet` (шаги 3–4 из «Быстрого старта»).

```bash
yarn install
yarn create-pool
```

Ожидаемый вывод (адреса у тебя будут свои):

```
[1/3] Создаю тестовые токены...
  TOKEN_A: <mint>
  TOKEN_B: <mint>
[2/3] Создаю CLMM-пул на Raydium devnet...
  Pool: <адрес пула>
  Tx  : https://explorer.solana.com/tx/...?cluster=devnet
[3/3] Сохраняю devnet-pool.json
```

Открой ссылку на пул в Solana Explorer (cluster = devnet): владелец аккаунта должен быть
`DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH` — это программа Raydium CLMM на devnet.

Пара полезных переменных окружения: `ANCHOR_WALLET` (другой кошелёк) и `DEVNET_RPC` (свой RPC, если публичный отвечает `429`).

### Что сдавать

Ссылку на коммит со скриптом и адрес своего пула (`poolId` из `devnet-pool.json`) со ссылкой на Explorer.

> Токены здесь без метаданных (имени и иконки): для учебного пула это не нужно, в Explorer они видны просто адресами.

---

## Требования

| Инструмент | Версия | Установка |
|---|---|---|
| Rust | stable | https://rustup.rs |
| Solana CLI | 1.18+ | https://docs.solana.com/cli/install-solana-cli-tools |
| Anchor CLI | 0.31.1 | `cargo install --git https://github.com/coral-xyz/anchor avm --locked && avm install 0.31.1 && avm use 0.31.1` |
| Node.js | 18+ | https://nodejs.org |
| Yarn | any | `npm i -g yarn` |

Rust-зависимости (`anchor-lang`, `anchor-spl` 0.31.1) подтянутся сами при `anchor build`.
JS-зависимости (`@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`, `@raydium-io/raydium-sdk-v2`, `decimal.js`, `ts-node`, `mocha`, `chai`, `typescript`) — через `yarn install`.

---

## Быстрый старт

### 1. Установить зависимости

```bash
cd Week-11
yarn install
```

### 2. Сбилдить контракт

```bash
anchor build
```

Если билдишь **первый раз** (новый keypair):

```bash
anchor keys sync   # обновит declare_id! в lib.rs и Anchor.toml
anchor build       # пересобрать с правильным ID
```

Артефакты в `target/deploy/`:
- `simple_vault.so` — программа
- `simple_vault-keypair.json` — keypair (не коммитить!)

### 3. Настроить Solana CLI на devnet

```bash
solana config set --url devnet
solana address     # твой публичный ключ — запомни его
solana balance
```

### 4. Пополнить кошелёк

Для деплоя нужно ~2 SOL.

```bash
solana airdrop 2   # может не сработать из-за rate limit
```

Если rate limit — используй faucet:
- https://faucet.solana.com (вставь свой адрес)

### 5. Задеплоить

```bash
anchor deploy --provider.cluster devnet
```

### 6. Запустить тесты

```bash
yarn test
```

Ожидаемый вывод:

```
✔ initialize_vault: vault создан
✔ create_user_card: у каждого пользователя своя карточка
✔ create_user_card: вторая карточка для того же пользователя — ошибка
✔ deposit: A вносит 100 токенов → 1 токен комиссии, 99 shares
✔ deposit: B вносит 50 токенов → 0.5 токена комиссии, 49.5 shares
✔ deposit: без карточки — ошибка
✔ deposit: сумма 0 — ошибка
✔ deposit: меньше минимума (1 токен) — ошибка
✔ deposit: ровно минимум (1 токен) проходит
✔ deposit: чужой fee_wallet — ошибка
✔ set_paused: не админ — ошибка
✔ deposit: vault на паузе — ошибка, после снятия паузы снова работает
✔ три пользователя: доли по shares пропорциональны внесённым суммам
✔ withdraw: A возвращает 49 shares → получает 49 токенов
✔ withdraw: сумма 0 — ошибка
✔ withdraw: больше своих shares — ошибка
✔ withdraw: без карточки — ошибка
✔ close_user_card: у пользователя ещё есть shares — ошибка
✔ withdraw_all: B сжигает все shares за один вызов
✔ withdraw_all: shares нет — ошибка
✔ close_user_card: shares 0 → карточка закрыта, рента возвращена
✔ deposit: после закрытия карточки — ошибка
✔ withdraw_all + close_user_card: C выводит всё и закрывает карточку
23 passing
```

---

## Структура проекта

```
Week-11/
├── programs/simple_vault/src/lib.rs
├── scripts/create-clmm-pool.ts
├── tests/vault.ts
├── Anchor.toml
├── Cargo.toml
└── package.json
```

---

## Частые ошибки

| Ошибка | Причина | Решение |
|---|---|---|
| `Insufficient funds` при деплое | мало SOL | пополни кошелёк на devnet |
| `AccountNotInitialized` в тестах | программа не задеплоена или другой ID | `anchor keys sync` → `anchor build` → `anchor deploy` |
| `already in use` при `create_user_card` | у пользователя уже есть карточка | это ожидаемо, карточка одна на пользователя |
| `AccountNotInitialized` (`user_card`) при `deposit` | нет карточки | сначала вызови `create_user_card` |
| `ZeroAmount` | `amount = 0` | вноси / выводи сумму больше нуля |
| `VaultEmpty` | в vault нет shares | сначала кто-то должен сделать `deposit` |
| `insufficient funds` при `withdraw` | shares меньше, чем просишь вернуть | проверь баланс share-аккаунта |
| `SharesTooSmall` | депозит слишком мал относительно vault | увеличь сумму |
| `DepositTooSmall` | сумма меньше `min_deposit` (1 токен) | вноси от 1 токена |
| `VaultPaused` | vault на паузе | админ вызывает `set_paused(false)` |
| `WrongFeeWallet` | передан не `vault_state.fee_wallet` | передавай `fee_wallet` из `vault_state` |
| `Unauthorized` при `set_paused` | вызвал не админ | подписывай кошельком админа vault |
| `CardNotEmpty` при `close_user_card` | в карточке остались shares | сначала `withdraw_all` |
| `429 Too Many Requests` | лимит публичного devnet RPC | подожди или возьми свой RPC (`DEVNET_RPC`) |
| `yarn create-pool` падает на `Insufficient funds` | мало SOL на devnet | пополни кошелёк (faucet.solana.com) |

---

## Задания для практики

1. Добавить комиссию 1% на депозит и отправлять её на `fee_wallet`.
2. Добавить минимальный депозит (например, 1 токен).
3. Добавить флаг `paused` в `VaultState`: админ может остановить депозиты.
4. Написать тест: трое пользователей вносят разные суммы, проверить доли по shares.
5. Добавить инструкцию `withdraw_all`, которая сжигает все shares пользователя за один вызов.
6. Закрывать карточку (`close`), если у пользователя не осталось shares, и возвращать ренту.

---

## Как выполнены задания

Контракт на неделе 11 не меняется, поэтому задания 1–6 перенесены из недели 10 без изменений.

| № | Задание | Что сделано | Тест |
|---|---|---|---|
| 1 | комиссия 1% на `fee_wallet` | `fee_wallet` задаётся в `initialize_vault`; в `deposit` 1% уходит на `fee_wallet`, shares считаются от остатка; чужой кошелёк — `WrongFeeWallet` | `deposit: A вносит 100 токенов → 1 токен комиссии, 99 shares`; `чужой fee_wallet — ошибка` |
| 2 | минимальный депозит 1 токен | `min_deposit = 10^decimals`; меньше — `DepositTooSmall` | `deposit: меньше минимума (1 токен) — ошибка`; `ровно минимум (1 токен) проходит` |
| 3 | `paused` | `set_paused` только для админа; на паузе `deposit` — `VaultPaused` | `set_paused: не админ — ошибка`; `deposit: vault на паузе — ошибка, после снятия паузы снова работает` |
| 4 | тест на трёх пользователей | — | `три пользователя: доли по shares пропорциональны внесённым суммам` |
| 5 | `withdraw_all` | вывод всех shares пользователя одним вызовом | `withdraw_all: B сжигает все shares за один вызов`; `withdraw_all: shares нет — ошибка` |
| 6 | закрыть пустую карточку | `close_user_card` закрывает карточку, только если shares = 0 (`CardNotEmpty`), рента возвращается владельцу | `close_user_card: shares 0 → карточка закрыта, рента возвращена` |
