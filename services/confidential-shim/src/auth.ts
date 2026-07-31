// Bearer auth with a timing-safe comparison. Both sides are hashed to a fixed
// length first so neither key length nor prefix match position leaks through
// response timing.

import { createHash, timingSafeEqual } from "node:crypto";

export function bearerMatches(
  authorizationHeader: string | undefined,
  expectedKey: string,
): boolean {
  if (authorizationHeader === undefined) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader);
  if (match === null || match[1] === undefined) return false;
  const provided = createHash("sha256").update(match[1]).digest();
  const expected = createHash("sha256").update(expectedKey).digest();
  return timingSafeEqual(provided, expected);
}
