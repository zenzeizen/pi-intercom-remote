import { randomInt } from "node:crypto";

/**
 * Room codes use a confusable-free alphabet (no 0/O, 1/I/L) and the format
 * AAA-999 — three letters, three digits. ~17.5 M combinations, plenty for
 * the simultaneous-room counts we expect (handfuls, not thousands).
 *
 * Generation is rejection-sampled rather than modulo to keep the distribution
 * uniform across the alphabet.
 */
const LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, L, O
const DIGITS = "23456789"; // no 0, 1

function pick(alphabet: string): string {
  const index = randomInt(0, alphabet.length);
  return alphabet[index]!;
}

export function generateRoomCode(): string {
  const letters = Array.from({ length: 3 }, () => pick(LETTERS)).join("");
  const digits = Array.from({ length: 3 }, () => pick(DIGITS)).join("");
  return `${letters}-${digits}`;
}

/** Normalize user input: uppercase, strip whitespace, allow missing dash. */
export function normalizeRoomCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 6) return input.toUpperCase();
  return `${cleaned.slice(0, 3)}-${cleaned.slice(3)}`;
}
