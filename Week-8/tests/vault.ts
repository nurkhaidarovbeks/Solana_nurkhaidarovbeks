import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint } from "@solana/spl-token";
import {
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
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const userA = Keypair.generate();
  const userB = Keypair.generate();
  const userC = Keypair.generate();

  let tokenMint: PublicKey;
  let vaultStatePDA: PublicKey;
  let vaultTokenAccountPDA: PublicKey;
  let shareMintPDA: PublicKey;

  const cardPda = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultStatePDA.toBuffer(), user.toBuffer()],
      program.programId
    )[0];

  const createCard = (user: Keypair) =>
    program.methods
      .createUserCard()
      .accounts({ vaultState: vaultStatePDA, userCard: cardPda(user.publicKey), user: user.publicKey } as any)
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

  before(async () => {
    await fundFromAdmin(provider, admin, userA.publicKey);
    await fundFromAdmin(provider, admin, userB.publicKey);
    await fundFromAdmin(provider, admin, userC.publicKey);

    tokenMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

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
        admin: admin.publicKey,
      } as any)
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.shareMint.toBase58(), shareMintPDA.toBase58());
    assert.isFalse(vault.paused);
  });

  it("create_user_card: у каждого пользователя своя карточка", async () => {
    for (const user of [userA, userB]) {
      const before = Math.floor(Date.now() / 1000);
      await createCard(user);

      const card = await program.account.userCard.fetch(cardPda(user.publicKey));
      assert.equal(card.owner.toBase58(), user.publicKey.toBase58());
      assert.equal(card.vault.toBase58(), vaultStatePDA.toBase58());
      assert.isTrue(Math.abs(card.createdAt.toNumber() - before) < 120, `created_at: ${card.createdAt}`);
    }
    assert.notEqual(cardPda(userA.publicKey).toBase58(), cardPda(userB.publicKey).toBase58());
  });

  it("create_user_card: вторая карточка для того же пользователя — ошибка", async () => {
    let failed = false;
    try {
      await createCard(userA);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "повторная карточка должна быть отклонена");
  });

  it("close_user_card: карточка закрывается, рента возвращается владельцу", async () => {
    const card = cardPda(userB.publicKey);
    const rent = (await provider.connection.getAccountInfo(card))!.lamports;
    const before = await provider.connection.getBalance(userB.publicKey);

    await closeCard(userB);

    assert.isNull(await provider.connection.getAccountInfo(card));
    const after = await provider.connection.getBalance(userB.publicKey);
    assert.equal(after - before, rent);
  });

  it("close_user_card: карточки нет — ошибка", async () => {
    let failed = false;
    try {
      await closeCard(userB);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "нельзя закрыть несуществующую карточку");
  });

  it("close_user_card: после закрытия карточку можно создать заново", async () => {
    await createCard(userB);
    const card = await program.account.userCard.fetch(cardPda(userB.publicKey));
    assert.equal(card.owner.toBase58(), userB.publicKey.toBase58());
  });

  it("set_paused: не админ — ошибка", async () => {
    await expectError(() => setPaused(true, userA), "Unauthorized");
  });

  it("create_user_card: vault на паузе — ошибка", async () => {
    await setPaused(true);
    assert.isTrue((await program.account.vaultState.fetch(vaultStatePDA)).paused);

    await expectError(() => createCard(userC), "VaultPaused");
    assert.isNull(await provider.connection.getAccountInfo(cardPda(userC.publicKey)));
  });

  it("create_user_card: после снятия паузы карточку можно создать", async () => {
    await setPaused(false);
    await createCard(userC);

    const card = await program.account.userCard.fetch(cardPda(userC.publicKey));
    assert.equal(card.owner.toBase58(), userC.publicKey.toBase58());
  });
});
