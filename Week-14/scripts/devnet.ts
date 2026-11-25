import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

export const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const WALLET = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(/^~/, os.homedir());

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export async function devnetConnection(): Promise<Connection> {
  const connection = new Connection(RPC, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    throw new Error(`${RPC} — это не devnet (genesis ${genesis}). Скрипты работают только в devnet.`);
  }
  return connection;
}

export function loadAdmin(): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, "utf8"))));
}

export const errorText = (e: any) => e?.message || e?.name || String(e);
