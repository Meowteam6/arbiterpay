// POST /api/junction/link issues a Junction Link token so a wallet can connect
// a wearable. Pinned here:
//   - a bad or missing address is a 400 before any Junction call.
//   - the happy path forwards exactly { userId, linkUrl } from the client.
//   - an upstream failure (a missing/invalid JUNCTION_API_KEY throws here) is a
//     502, not a crash and not a fake success. This is the credential gate:
//     with no key every Junction call throws, so the route reports the failure
//     rather than pretending a device could be linked.

import { describe, it, expect, vi, beforeEach } from "vitest";

const createLinkToken = vi.fn();

vi.mock("@/lib/server/junction", () => ({
  createLinkToken: (...args: unknown[]) => createLinkToken(...args),
}));

const { POST } = await import("@/app/api/junction/link/route");

const USER = "0x1111111111111111111111111111111111111111";

function post(body: unknown, raw = false) {
  return POST(
    new Request("http://localhost/api/junction/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  createLinkToken.mockResolvedValue({
    userId: "vital-1",
    linkUrl: "https://link.tryvital.io/?token=abc&env=sandbox&region=us",
  });
});

describe("POST /api/junction/link", () => {
  it("returns the userId and link URL for a valid address", async () => {
    const res = await post({ address: USER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "vital-1",
      linkUrl: "https://link.tryvital.io/?token=abc&env=sandbox&region=us",
    });
    expect(createLinkToken).toHaveBeenCalledWith(USER);
  });

  it("rejects a non-string address before touching Junction", async () => {
    const res = await post({ address: 42 });
    expect(res.status).toBe(400);
    expect(createLinkToken).not.toHaveBeenCalled();
  });

  it("rejects a malformed 0x address before touching Junction", async () => {
    const res = await post({ address: "0xnope" });
    expect(res.status).toBe(400);
    expect(createLinkToken).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const res = await post("{not json", true);
    expect(res.status).toBe(400);
    expect(createLinkToken).not.toHaveBeenCalled();
  });

  it("maps an upstream Junction failure to a 502 rather than crashing", async () => {
    // With no JUNCTION_API_KEY the client throws before the first fetch; an
    // invalid key throws on the 401. Either way the route must answer, not 500.
    createLinkToken.mockRejectedValue(
      new Error("Junction /v2/link/token returned 401: invalid api key"),
    );
    const res = await post({ address: USER });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });
});
