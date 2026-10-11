import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  hasValidCloudflareAccess: vi.fn<(request: Request) => Promise<boolean>>(),
}));

vi.mock("../../../../lib/cloudflare-access", () => ({
  hasValidCloudflareAccess: mocks.hasValidCloudflareAccess,
}));

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

function request(body: unknown): Request {
  return new Request("http://web:8765/api/moneyforward/operations", {
    method: "POST",
    headers: {
      origin: "https://dashboard.example.com",
      "x-forwarded-host": "dashboard.example.com",
      "x-forwarded-proto": "https",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("/api/moneyforward/operations", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CRAWLER_URL: "http://crawler:8766",
      REFRESH_TOKEN: "refresh-token",
    };
    global.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ running: true }), { status: 202 }));
    mocks.hasValidCloudflareAccess.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  it("requires Cloudflare Access", async () => {
    mocks.hasValidCloudflareAccess.mockResolvedValue(false);

    const response = await POST(request({}));

    expect(response.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forwards a validated calculation-exclusion operation", async () => {
    const operation = {
      type: "set-calculation-exclusion",
      month: "2025-07",
      transactionId: "mf-tx-1",
      excluded: true,
    };

    const response = await POST(request(operation));

    expect(response.status).toBe(202);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://crawler:8766/operations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(operation),
        headers: expect.objectContaining({ authorization: "Bearer refresh-token" }),
      }),
    );
  });

  it("rejects unsupported operation types", async () => {
    const response = await POST(request({ type: "arbitrary-update" }));

    expect(response.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
