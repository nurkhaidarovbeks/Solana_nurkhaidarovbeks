import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../idl/simple_vault.json";
import type { SimpleVault } from "../idl/simple_vault";
import { PROGRAM_ID, RPC_URL, TOKEN_MINT } from "../config";
import type { BrowserWallet } from "./wallet";
import { tokenBalance } from "./balance";

export const connection = new Connection(RPC_URL, "confirmed");

const toBig = (bn: BN) => BigInt(bn.toString());
const toBN = (n: bigint) => new BN(n.toString());

const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const vaultPdaFor = (mint: PublicKey) => pda(Buffer.from("vault"), mint.toBuffer());
export const cardPdaFor = (vault: PublicKey, user: PublicKey) =>
  pda(Buffer.from("user_card"), vault.toBuffer(), user.toBuffer());

export const vaultPda = vaultPdaFor(TOKEN_MINT);
export const vaultTokensPda = pda(Buffer.from("vault_tokens"), TOKEN_MINT.toBuffer());
export const shareMintPda = pda(Buffer.from("share_mint"), TOKEN_MINT.toBuffer());
export const cardPda = (user: PublicKey) => cardPdaFor(vaultPda, user);
export const userTokenAta = (user: PublicKey) => getAssociatedTokenAddressSync(TOKEN_MINT, user);
export const userShareAta = (user: PublicKey) => getAssociatedTokenAddressSync(shareMintPda, user);

const readOnlySigner = {
  publicKey: Keypair.generate().publicKey,
  signTransaction: () => Promise.reject(new Error("Подключите кошелёк")),
  signAllTransactions: () => Promise.reject(new Error("Подключите кошелёк")),
};
let readOnlyProgram: Program<SimpleVault> | undefined;

export function getProgram(wallet?: BrowserWallet): Program<SimpleVault> {
  if (!wallet && readOnlyProgram) return readOnlyProgram;
  const provider = new AnchorProvider(connection, (wallet ?? readOnlySigner) as any, { commitment: "confirmed" });
  const program = new Program<SimpleVault>(idl as SimpleVault, provider);
  if (!wallet) readOnlyProgram = program;
  return program;
}

export interface VaultView {
  admin: PublicKey;
  decimals: number;
  totalTokens: bigint;
  totalShares: bigint;
  feeWallet: PublicKey;
  minDeposit: bigint;
  paused: boolean;
  inMarket: boolean;
  pairSet: boolean;
  positionOpen: boolean;
  vaultTokenAccountB: PublicKey;
  totalFeesA: bigint;
  totalFeesB: bigint;
}

export async function loadVault(): Promise<VaultView | null> {
  const info = await connection.getAccountInfo(vaultPda);
  if (!info) return null;
  let state;
  try {
    state = getProgram().coder.accounts.decode("vaultState", info.data);
  } catch {
    throw new Error(
      "Vault из vault-config.json создан другой версией контракта. Админ: задеплойте контракт и выполните yarn setup-demo."
    );
  }
  const mint = await getMint(connection, TOKEN_MINT);
  return {
    admin: state.admin,
    decimals: mint.decimals,
    totalTokens: toBig(state.totalTokens),
    totalShares: toBig(state.totalShares),
    feeWallet: state.feeWallet,
    minDeposit: toBig(state.minDeposit),
    paused: state.paused,
    inMarket: state.inMarket,
    pairSet: !state.tokenMintB.equals(PublicKey.default),
    positionOpen: !state.positionNftMint.equals(PublicKey.default),
    vaultTokenAccountB: state.vaultTokenAccountB,
    totalFeesA: toBig(state.totalFeesA),
    totalFeesB: toBig(state.totalFeesB),
  };
}

export interface UserView {
  sol: number;
  tokens: bigint;
  shares: bigint;
  card: { deposited: bigint; shares: bigint } | null;
}

export async function loadUser(owner: PublicKey): Promise<UserView> {
  const program = getProgram();
  const [lamports, tokens, shares, card] = await Promise.all([
    connection.getBalance(owner),
    tokenBalance(connection, owner, TOKEN_MINT),
    tokenBalance(connection, owner, shareMintPda),
    program.account.userCard.fetchNullable(cardPda(owner)),
  ]);
  return {
    sol: lamports / 1e9,
    tokens,
    shares,
    card: card ? { deposited: toBig(card.deposited), shares: toBig(card.shares) } : null,
  };
}

export function createCard(wallet: BrowserWallet): Promise<string> {
  return getProgram(wallet)
    .methods.createUserCard()
    .accountsPartial({ vaultState: vaultPda, userCard: cardPda(wallet.publicKey), user: wallet.publicKey })
    .rpc();
}

export function closeCard(wallet: BrowserWallet): Promise<string> {
  return getProgram(wallet)
    .methods.closeUserCard()
    .accountsPartial({ vaultState: vaultPda, userCard: cardPda(wallet.publicKey), user: wallet.publicKey })
    .rpc();
}

function userAccounts(user: PublicKey) {
  return {
    vaultState: vaultPda,
    userCard: cardPda(user),
    vaultTokenAccount: vaultTokensPda,
    shareMint: shareMintPda,
    userTokenAccount: userTokenAta(user),
    userShareAccount: userShareAta(user),
    user,
  };
}

export function deposit(wallet: BrowserWallet, amount: bigint, feeWallet: PublicKey): Promise<string> {
  const accounts = userAccounts(wallet.publicKey);
  return getProgram(wallet)
    .methods.deposit(toBN(amount))
    .accountsPartial({ ...accounts, feeWallet })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        accounts.userShareAccount,
        wallet.publicKey,
        shareMintPda
      ),
    ])
    .rpc();
}

function tokenAtaIx(user: PublicKey) {
  return createAssociatedTokenAccountIdempotentInstruction(user, userTokenAta(user), user, TOKEN_MINT);
}

export function withdraw(wallet: BrowserWallet, shares: bigint): Promise<string> {
  return getProgram(wallet)
    .methods.withdraw(toBN(shares))
    .accountsPartial(userAccounts(wallet.publicKey))
    .preInstructions([tokenAtaIx(wallet.publicKey)])
    .rpc();
}

export function withdrawAll(wallet: BrowserWallet): Promise<string> {
  return getProgram(wallet)
    .methods.withdrawAll()
    .accountsPartial(userAccounts(wallet.publicKey))
    .preInstructions([tokenAtaIx(wallet.publicKey)])
    .rpc();
}

export function syncVault(wallet: BrowserWallet, vaultTokenAccountB: PublicKey): Promise<string> {
  return getProgram(wallet)
    .methods.syncVault()
    .accountsPartial({
      admin: wallet.publicKey,
      vaultState: vaultPda,
      vaultTokenAccount: vaultTokensPda,
      vaultTokenAccountB,
    })
    .rpc();
}

export function setPaused(wallet: BrowserWallet, paused: boolean): Promise<string> {
  return getProgram(wallet)
    .methods.setPaused(paused)
    .accountsPartial({ admin: wallet.publicKey, vaultState: vaultPda })
    .rpc();
}

export function watchAccounts(keys: PublicKey[], onChange: () => void): () => void {
  const ids = keys.map((key) => connection.onAccountChange(key, onChange, { commitment: "confirmed" }));
  return () => ids.forEach((id) => connection.removeAccountChangeListener(id).catch(() => {}));
}
