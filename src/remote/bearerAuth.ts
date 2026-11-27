import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of an `Authorization` header against `Bearer <token>`.
 *
 * A missing header is treated as "" (so it never matches), exactly as the previous
 * `(req.headers.authorization ?? "") !== \`Bearer ${token}\`` comparison did.
 * `timingSafeEqual` throws on unequal lengths, so the lengths are compared first.
 * Both sides are encoded as UTF-16LE so every JS string round-trips losslessly
 * (UTF-8 would map lone surrogates to U+FFFD and make distinct strings compare equal).
 */
export function isAuthorizedBearer(header: string | undefined, token: string): boolean {
  const received = Buffer.from(header ?? "", "utf16le");
  const expected = Buffer.from(`Bearer ${token}`, "utf16le");
  if (received.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(received, expected);
}
