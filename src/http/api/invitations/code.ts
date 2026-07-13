import { randomInt } from "node:crypto";

// URL-safe, no visually ambiguous chars (0/O/1/l/I). 10 chars → ~57 bits entropy.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function generateInviteCode(): string {
  let out = "";
  for (let i = 0; i < 10; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
