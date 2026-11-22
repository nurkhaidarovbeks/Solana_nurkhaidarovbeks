# Solana

Практика по Solana / Anchor по неделям: учебный контракт **Simple Vault** на Anchor 0.31.1 (devnet).

Каждая папка `Week-N` — отдельный самостоятельный проект: код контракта на эту неделю, тесты и
выполненные задания для практики этой недели. Папки не зависят друг от друга, каждую можно
собрать и протестировать отдельно.

---

## Недели

| Неделя | Папка | Тема | Что сделано |
|---|---|---|---|
| 8 | [Week-8](./Week-8) | Vault и карточки пользователей | `created_at`, `close_user_card`, пауза на создание карточек |
| 9 | [Week-9](./Week-9) | Депозит и share-токены | комиссия 1% на `fee_wallet`, минимальный депозит, пауза депозитов, тест на доли трёх пользователей |
| 10 | [Week-10](./Week-10) | Вывод через CPI | задания 1–4, `withdraw_all`, закрытие пустой карточки с возвратом ренты |

---

## Что такое Simple Vault

Vault — общее хранилище одного SPL-токена. Пользователи вносят токены и получают взамен
share-токены (доли). Чем больше доля, тем больше токенов можно забрать обратно.

```
                 deposit(amount)
  пользователь ───────────────────►  vault_token_account  (токены всех пользователей)
       ▲            │                       │
       │            │ 1% комиссии           │
       │            ▼                       │
       │        fee_wallet                  │
       │                                    │
       │  токены обратно                    │ withdraw(shares) / withdraw_all
       └────────────────────────────────────┘
```

Основные аккаунты (PDA):

| Аккаунт | Seeds | Зачем |
|---|---|---|
| `vault_state` | `["vault", token_mint]` | настройки и счётчики vault: админ, `total_tokens`, `total_shares`, `paused` и т.д. |
| `vault_token_account` | `["vault_tokens", token_mint]` | токены, внесённые пользователями; владелец — vault PDA |
| `share_mint` | `["share_mint", token_mint]` | mint share-токенов; печатать может только vault PDA |
| `user_card` | `["user_card", vault_state, user]` | личная карточка пользователя: сколько внёс и сколько shares |

Формулы долей:

```
депозит:  shares = net × total_shares / total_tokens     (первый депозит — 1:1)
вывод:    tokens = shares × total_tokens / total_shares
```

`net` — сумма депозита после комиссии.

---

## Что по неделям

### Week 8 — vault и карточки

- `initialize_vault` — админ создаёт vault для токена.
- `create_user_card` — пользователь создаёт свою карточку (одна на пользователя).
- Задания: поле `created_at` в карточке, `close_user_card` с возвратом ренты,
  `set_paused` — пока vault на паузе, карточки не создаются.

### Week 9 — депозит и shares

- `deposit(amount)` — токены уходят в vault, пользователю печатаются shares.
- Задания: комиссия 1% на `fee_wallet`, минимальный депозит 1 токен,
  `set_paused` останавливает депозиты, тест с тремя пользователями на пропорции долей.

### Week 10 — вывод и CPI

- `withdraw(shares)` — shares сжигаются (`burn`), токены возвращаются из vault
  (`transfer` с подписью vault PDA через seeds).
- Задания: всё из недели 9, плюс `withdraw_all` (вывести всё за один вызов)
  и `close_user_card` — закрыть карточку, когда shares не осталось, и вернуть ренту.

---

## Как запустить любую неделю

Нужны Rust, Solana CLI 1.18+, Anchor CLI 0.31.1, Node.js 18+ и Yarn.

```bash
cd Week-10              # нужная неделя
yarn install
anchor build
anchor keys sync        # при первом билде: обновит program id
anchor build
solana config set --url devnet
anchor deploy --provider.cluster devnet
yarn test
```

Для деплоя нужно ~2 SOL на devnet: `solana airdrop 2` или https://faucet.solana.com.
Подробности, ожидаемый вывод тестов и частые ошибки — в README внутри каждой папки.

---

## Структура

```
Solana/
├── README.md
├── Week-8/
│   ├── programs/simple_vault/src/lib.rs
│   ├── tests/vault.ts
│   └── README.md
├── Week-9/
│   └── ...
└── Week-10/
    └── ...
```
