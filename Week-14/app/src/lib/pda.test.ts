import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { cardPdaFor, vaultPdaFor } from "./vault";

const DEMO_MINT = new PublicKey("HPQhcuZG2dVbkDXraoE8mnNQZmuir42fDQ7Jc3ooDppi");
const DEMO_VAULT = "DfRo9KAMbjoY3hEKMrKSuJ2zBxZQ2TXGP93vywkqN34J";

describe("PDA совпадают с теми, что создал контракт", () => {
  it("vault: seeds [vault, token_mint]", () => {
    expect(vaultPdaFor(DEMO_MINT).toBase58()).toBe(DEMO_VAULT);
  });

  it("карточка: seeds [user_card, vault, user], а не [user_card, user, vault]", () => {
    const user = new PublicKey("9dxphrAwvbknrvjBnGg3FsN5nQooW3uLeK2kzJy9WiLG");
    expect(cardPdaFor(new PublicKey(DEMO_VAULT), user).toBase58()).toBe("9Ws2QUpnvgCKxsLYezNbm69WiBhWuyod3xTZBZRcVk13");
  });
});
