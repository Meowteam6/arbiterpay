// Shared helpers for API route handlers.
//
// The two failure helpers exist for opposite audiences. errorMessage is for
// the SERVER log: it walks the cause chain so a wrapped SDK failure never
// hides the real one. safeError is for the CLIENT: those same chained
// messages carry RPC URLs, store paths, ledger file names, wallet ids and
// contract internals, and every route in this app is reachable by anyone with
// the URL. A correlation id is the only thing both sides share, so a user can
// quote it and an operator can grep for it.

export function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * A short id for one request, prefixed with the route that minted it — e.g.
 * "evidence-submit-3f9a2c11". Short enough for a human to read back over
 * support, unique enough to find one line in a log.
 */
export function newCorrelationId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Log the real failure server-side, in full, and return a generic line that
 * is safe to hand an unauthenticated caller.
 *
 * Never return errorMessage(err) or err.message to a client: the money paths
 * wrap viem, Circle and store errors whose text leaks infrastructure detail.
 * The failure stays LOUD where it matters (the server log) and opaque where
 * it would help an attacker.
 */
export function safeError(err: unknown, correlationId: string): string {
  console.error(`[${correlationId}] ${errorMessage(err)}`, err);
  return `Something went wrong on our side. Reference ${correlationId}.`;
}

/**
 * Normalize unknown thrown values into a readable message. Walks the `.cause`
 * chain so wrapped errors never hide the real failure — e.g. the Unlink SDK's
 * `CapabilityError("token provider failed")` carries the actual engine error
 * (HTTP status/body) in `.cause`, which is the part we actually need to see.
 */
export function errorMessage(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.length > 0 ? parts.join(" — caused by: ") : String(err);
}

export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Body must be a JSON object");
    }
    return body as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid JSON body: ${errorMessage(err)}`);
  }
}
