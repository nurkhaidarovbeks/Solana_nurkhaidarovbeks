# Simple Vault — практика Anchor

Учебный контракт на Anchor 0.31.1 (Solana). Сейчас он делает три вещи:

1. **Vault создан** — админ создаёт vault для SPL-токена. *(неделя 8)*
2. **У каждого пользователя своя «карточка»** — личный аккаунт (PDA) внутри vault. *(неделя 8)*
3. **Депозит и share-токены** — пользователь вносит токены и получает share-токены. *(неделя 9)*

Контракт будет дорабатываться (вывод, Raydium и т.д.), поэтому он намеренно небольшой.

---

## Что делает контракт

```
initialize_vault    создаёт VaultState PDA, vault token account и share mint
create_user_card    создаёт UserCard PDA — личную карточку пользователя в vault
deposit(amount)     переводит токены пользователя в vault → печатает ему shares
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
| `deposited` | сколько токенов пользователь внёс всего |
| `shares` | сколько share-токенов он получил |
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

Для вызова `deposit` нужны: токен-аккаунт пользователя (с токенами vault) и share-аккаунт пользователя
(для share mint), а также `fee_wallet` из `vault_state`. В тестах они создаются через `createAccount` из `@solana/spl-token`.

### `set_paused(paused)`

Вызывает только админ vault (иначе `Unauthorized`). Пока `paused = true`, `deposit` возвращает `VaultPaused`.

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
JS-зависимости (`@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`, `mocha`, `chai`, `typescript`) — через `yarn install`.

---

## Быстрый старт

### 1. Установить зависимости

```bash
cd Week-9
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
13 passing
```

---

## Структура проекта

```
Week-9/
├── programs/simple_vault/src/lib.rs
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
| `ZeroAmount` | `amount = 0` | вноси сумму больше нуля |
| `SharesTooSmall` | депозит слишком мал относительно vault | увеличь сумму |
| `DepositTooSmall` | сумма меньше `min_deposit` (1 токен) | вноси от 1 токена |
| `VaultPaused` | vault на паузе | админ вызывает `set_paused(false)` |
| `WrongFeeWallet` | передан не `vault_state.fee_wallet` | передавай `fee_wallet` из `vault_state` |
| `Unauthorized` при `set_paused` | вызвал не админ | подписывай кошельком админа vault |
| `429 Too Many Requests` | лимит публичного devnet RPC | подожди или возьми свой RPC |

---

## Задания для практики

1. Добавить комиссию 1% на депозит и отправлять её на `fee_wallet`.
2. Добавить минимальный депозит (например, 1 токен).
3. Добавить флаг `paused` в `VaultState`: админ может остановить депозиты.
4. Написать тест: трое пользователей вносят разные суммы, проверить доли по shares.
