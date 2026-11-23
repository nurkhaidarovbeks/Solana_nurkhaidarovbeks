import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SimpleVault } from "../target/types/simple_vault";

async function fundFromAdmin(
  provider: anchor.AnchorProvider,
  admin: Keypair,
  pubkey: PublicKey,
  lamports = 0.05 * LAMPORTS_PER_SOL
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: pubkey, lamports })
  );
  await provider.sendAndConfirm(tx, [admin]);
}

describe("simple_vault", () => {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(new Connection(env.connection.rpcEndpoint, "confirmed"), env.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const userA = Keypair.generate();
  const userB = Keypair.generate();
  const userC = Keypair.generate();
  const userD = Keypair.generate();

  let tokenMint: PublicKey;
  let vaultStatePDA: PublicKey;
  let vaultTokenAccountPDA: PublicKey;
  let shareMintPDA: PublicKey;
  let feeWallet: PublicKey;

  const tokenAcc: Record<string, PublicKey> = {};
  const shareAcc: Record<string, PublicKey> = {};
  const UNIT = 1_000_000;

  const cardPda = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultStatePDA.toBuffer(), user.toBuffer()],
      program.programId
    )[0];

  const deposit = (user: Keypair, amount: number, fee: PublicKey = feeWallet) =>
    program.methods
      .deposit(new anchor.BN(amount))
      .accounts({
        vaultState: vaultStatePDA,
        userCard: cardPda(user.publicKey),
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        userTokenAccount: tokenAcc[user.publicKey.toBase58()],
        userShareAccount: shareAcc[user.publicKey.toBase58()],
        feeWallet: fee,
        user: user.publicKey,
      } as any)
      .signers([user])
      .rpc();

  const withdrawAccounts = (user: Keypair) => ({
    vaultState: vaultStatePDA,
    userCard: cardPda(user.publicKey),
    vaultTokenAccount: vaultTokenAccountPDA,
    shareMint: shareMintPDA,
    userTokenAccount: tokenAcc[user.publicKey.toBase58()],
    userShareAccount: shareAcc[user.publicKey.toBase58()],
    user: user.publicKey,
  });

  const withdraw = (user: Keypair, sharesAmount: number) =>
    program.methods
      .withdraw(new anchor.BN(sharesAmount))
      .accounts(withdrawAccounts(user) as any)
      .signers([user])
      .rpc();

  const withdrawAll = (user: Keypair) =>
    program.methods
      .withdrawAll()
      .accounts(withdrawAccounts(user) as any)
      .signers([user])
      .rpc();

  const closeCard = (user: Keypair) =>
    program.methods
      .closeUserCard()
      .accounts({ vaultState: vaultStatePDA, userCard: cardPda(user.publicKey), user: user.publicKey } as any)
      .signers([user])
      .rpc();

  const setPaused = (paused: boolean, signer: Keypair = admin) =>
    program.methods
      .setPaused(paused)
      .accounts({ admin: signer.publicKey, vaultState: vaultStatePDA } as any)
      .signers(signer === admin ? [] : [signer])
      .rpc();

  const expectError = async (fn: () => Promise<unknown>, code: string) => {
    try {
      await fn();
    } catch (e: any) {
      const text = `${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""} ${(e?.logs ?? []).join(" ")}`;
      assert.include(text, code, `ожидали ошибку ${code}, получили: ${text.slice(0, 300)}`);
      return;
    }
    assert.fail(`ожидали ошибку ${code}, но вызов прошёл`);
  };

  const feeBalance = async () => (await getAccount(provider.connection, feeWallet)).amount;
  const shareBalance = async (user: Keypair) =>
    (await getAccount(provider.connection, shareAcc[user.publicKey.toBase58()])).amount;
  const tokenBalance = async (user: Keypair) =>
    (await getAccount(provider.connection, tokenAcc[user.publicKey.toBase58()])).amount;

  before(async () => {
    for (const user of [userA, userB, userC, userD]) {
      await fundFromAdmin(provider, admin, user.publicKey);
    }

    tokenMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    feeWallet = await createAccount(provider.connection, admin, tokenMint, admin.publicKey);

    [vaultStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    [vaultTokenAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
      program.programId
    );
    [shareMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()],
      program.programId
    );
  });

  it("initialize_vault: vault создан", async () => {
    await program.methods
      .initializeVault()
      .accounts({
        vaultState: vaultStatePDA,
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        tokenMint,
        feeWallet,
        admin: admin.publicKey,
      } as any)
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.shareMint.toBase58(), shareMintPDA.toBase58());
    assert.equal(vault.feeWallet.toBase58(), feeWallet.toBase58());
    assert.equal(vault.minDeposit.toNumber(), UNIT);
    assert.isFalse(vault.paused);
  });

  it("create_user_card: у каждого пользователя своя карточка", async () => {
    for (const user of [userA, userB, userC]) {
      const userCard = cardPda(user.publicKey);
      await program.methods
        .createUserCard()
        .accounts({ vaultState: vaultStatePDA, userCard, user: user.publicKey } as any)
        .signers([user])
        .rpc();

      const card = await program.account.userCard.fetch(userCard);
      assert.equal(card.owner.toBase58(), user.publicKey.toBase58());
      assert.equal(card.vault.toBase58(), vaultStatePDA.toBase58());
    }
    assert.notEqual(cardPda(userA.publicKey).toBase58(), cardPda(userB.publicKey).toBase58());
  });

  it("create_user_card: вторая карточка для того же пользователя — ошибка", async () => {
    let failed = false;
    try {
      await program.methods
        .createUserCard()
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userA.publicKey),
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "повторная карточка должна быть отклонена");
  });

  it("deposit: A вносит 100 токенов → 1 токен комиссии, 99 shares", async () => {
    for (const user of [userA, userB, userC, userD]) {
      const key = user.publicKey.toBase58();
      tokenAcc[key] = await createAccount(provider.connection, admin, tokenMint, user.publicKey);
      shareAcc[key] = await createAccount(provider.connection, admin, shareMintPDA, user.publicKey);
      await mintTo(provider.connection, admin, tokenMint, tokenAcc[key], admin, 1000 * UNIT);
    }

    await deposit(userA, 100 * UNIT);

    assert.equal(await shareBalance(userA), BigInt(99 * UNIT));
    assert.equal(await feeBalance(), BigInt(1 * UNIT));

    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    assert.equal(card.deposited.toNumber(), 99 * UNIT);
    assert.equal(card.shares.toNumber(), 99 * UNIT);
  });

  it("deposit: B вносит 50 токенов → 0.5 токена комиссии, 49.5 shares", async () => {
    await deposit(userB, 50 * UNIT);

    assert.equal(await shareBalance(userB), BigInt(49_500_000));
    assert.equal(await feeBalance(), BigInt(1_500_000));

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.totalTokens.toNumber(), 148_500_000);
    assert.equal(vault.totalShares.toNumber(), 148_500_000);

    const vaultTokens = await getAccount(provider.connection, vaultTokenAccountPDA);
    assert.equal(vaultTokens.amount, BigInt(148_500_000));
  });

  it("deposit: без карточки — ошибка", async () => {
    let failed = false;
    try {
      await deposit(userD, 10 * UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "депозит без карточки должен быть отклонён");
  });

  it("deposit: сумма 0 — ошибка", async () => {
    await expectError(() => deposit(userA, 0), "ZeroAmount");
  });

  it("deposit: меньше минимума (1 токен) — ошибка", async () => {
    await expectError(() => deposit(userA, UNIT / 2), "DepositTooSmall");
    await expectError(() => deposit(userA, UNIT - 1), "DepositTooSmall");
  });

  it("deposit: ровно минимум (1 токен) проходит", async () => {
    const sharesBefore = await shareBalance(userC);
    const feeBefore = await feeBalance();

    await deposit(userC, UNIT);

    assert.equal((await shareBalance(userC)) - sharesBefore, BigInt(990_000));
    assert.equal((await feeBalance()) - feeBefore, BigInt(10_000));
  });

  it("deposit: чужой fee_wallet — ошибка", async () => {
    await expectError(
      () => deposit(userA, 10 * UNIT, tokenAcc[userA.publicKey.toBase58()]),
      "WrongFeeWallet"
    );
  });

  it("set_paused: не админ — ошибка", async () => {
    await expectError(() => setPaused(true, userA), "Unauthorized");
  });

  it("deposit: vault на паузе — ошибка, после снятия паузы снова работает", async () => {
    await setPaused(true);
    assert.isTrue((await program.account.vaultState.fetch(vaultStatePDA)).paused);

    const sharesBefore = await shareBalance(userB);
    await expectError(() => deposit(userB, 10 * UNIT), "VaultPaused");
    assert.equal(await shareBalance(userB), sharesBefore);

    await setPaused(false);
    assert.isFalse((await program.account.vaultState.fetch(vaultStatePDA)).paused);

    await deposit(userB, 10 * UNIT);
    assert.equal((await shareBalance(userB)) - sharesBefore, BigInt(9_900_000));
  });

  it("три пользователя: доли по shares пропорциональны внесённым суммам", async () => {
    await deposit(userC, 200 * UNIT);

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    const totalShares = BigInt(vault.totalShares.toString());
    const totalTokens = BigInt(vault.totalTokens.toString());

    const users = [userA, userB, userC];
    const shares: bigint[] = [];
    const deposited: bigint[] = [];
    for (const user of users) {
      const card = await program.account.userCard.fetch(cardPda(user.publicKey));
      shares.push(await shareBalance(user));
      deposited.push(BigInt(card.deposited.toString()));
      assert.equal(BigInt(card.shares.toString()), shares[shares.length - 1]);
    }

    assert.deepEqual(shares, [BigInt(99_000_000), BigInt(59_400_000), BigInt(198_990_000)]);
    assert.equal(shares[0] + shares[1] + shares[2], totalShares);
    assert.equal(deposited[0] + deposited[1] + deposited[2], totalTokens);

    for (let i = 0; i < users.length; i++) {
      assert.equal(shares[i] * totalTokens, deposited[i] * totalShares, `доля пользователя ${i}`);
    }

    const vaultTokens = await getAccount(provider.connection, vaultTokenAccountPDA);
    assert.equal(vaultTokens.amount, totalTokens);
    assert.equal(await feeBalance(), BigInt(1_500_000 + 10_000 + 100_000 + 2_000_000));
  });

  it("withdraw: A возвращает 49 shares → получает 49 токенов", async () => {
    const before = await tokenBalance(userA);
    const vaultBefore = await program.account.vaultState.fetch(vaultStatePDA);

    await withdraw(userA, 49 * UNIT);

    assert.equal((await tokenBalance(userA)) - before, BigInt(49 * UNIT));
    assert.equal(await shareBalance(userA), BigInt(50 * UNIT));

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vaultBefore.totalTokens.toNumber() - vault.totalTokens.toNumber(), 49 * UNIT);
    assert.equal(vaultBefore.totalShares.toNumber() - vault.totalShares.toNumber(), 49 * UNIT);

    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    assert.equal(card.deposited.toNumber(), 50 * UNIT);
    assert.equal(card.shares.toNumber(), 50 * UNIT);
  });

  it("withdraw: сумма 0 — ошибка", async () => {
    await expectError(() => withdraw(userA, 0), "ZeroAmount");
  });

  it("withdraw: больше своих shares — ошибка", async () => {
    let failed = false;
    try {
      await withdraw(userA, 51 * UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "нельзя вывести больше своих shares");
  });

  it("withdraw: без карточки — ошибка", async () => {
    let failed = false;
    try {
      await withdraw(userD, 1 * UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "вывод без карточки должен быть отклонён");
  });

  it("close_user_card: у пользователя ещё есть shares — ошибка", async () => {
    await expectError(() => closeCard(userA), "CardNotEmpty");
    assert.isNotNull(await provider.connection.getAccountInfo(cardPda(userA.publicKey)));
  });

  it("withdraw_all: B сжигает все shares за один вызов", async () => {
    const sharesBefore = await shareBalance(userB);
    const tokensBefore = await tokenBalance(userB);
    const vaultBefore = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(sharesBefore, BigInt(59_400_000));

    await withdrawAll(userB);

    assert.equal(await shareBalance(userB), BigInt(0));
    assert.equal((await tokenBalance(userB)) - tokensBefore, sharesBefore);

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vaultBefore.totalShares.toNumber() - vault.totalShares.toNumber(), 59_400_000);
    assert.equal(vaultBefore.totalTokens.toNumber() - vault.totalTokens.toNumber(), 59_400_000);

    const card = await program.account.userCard.fetch(cardPda(userB.publicKey));
    assert.equal(card.shares.toNumber(), 0);
    assert.equal(card.deposited.toNumber(), 0);
  });

  it("withdraw_all: shares нет — ошибка", async () => {
    await expectError(() => withdrawAll(userB), "ZeroAmount");
  });

  it("close_user_card: shares 0 → карточка закрыта, рента возвращена", async () => {
    const card = cardPda(userB.publicKey);
    const rent = (await provider.connection.getAccountInfo(card))!.lamports;
    const before = await provider.connection.getBalance(userB.publicKey);

    await closeCard(userB);

    assert.isNull(await provider.connection.getAccountInfo(card));
    const after = await provider.connection.getBalance(userB.publicKey);
    assert.equal(after - before, rent);
  });

  it("deposit: после закрытия карточки — ошибка", async () => {
    let failed = false;
    try {
      await deposit(userB, 10 * UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "депозит без карточки должен быть отклонён");
  });

  it("withdraw_all + close_user_card: C выводит всё и закрывает карточку", async () => {
    const shares = await shareBalance(userC);
    const tokensBefore = await tokenBalance(userC);

    await withdrawAll(userC);
    await closeCard(userC);

    assert.equal((await tokenBalance(userC)) - tokensBefore, shares);
    assert.isNull(await provider.connection.getAccountInfo(cardPda(userC.publicKey)));

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.totalShares.toNumber(), 50 * UNIT);
    assert.equal(vault.totalTokens.toNumber(), 50 * UNIT);
    const vaultTokens = await getAccount(provider.connection, vaultTokenAccountPDA);
    assert.equal(vaultTokens.amount, BigInt(50 * UNIT));
  });
});
