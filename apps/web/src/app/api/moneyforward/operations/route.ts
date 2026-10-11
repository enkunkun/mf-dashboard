import { NextResponse } from "next/server";
import { hasValidCloudflareAccess } from "../../../../lib/cloudflare-access";
import { parseCrawlerRefreshStatus } from "../../../../lib/crawler-refresh-status";
import { isSameOriginRequest } from "../../../../lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!(await hasValidCloudflareAccess(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }

  const rawBody = await request.text();
  if (!rawBody || rawBody.length > 1024) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid MoneyForward operation" }, { status: 400 });
  }

  const type = Reflect.get(body, "type");
  const month = Reflect.get(body, "month");
  const transactionId = Reflect.get(body, "transactionId");
  const excluded = Reflect.get(body, "excluded");
  if (
    type !== "set-calculation-exclusion" ||
    typeof month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    typeof transactionId !== "string" ||
    !/^[\w-]{1,200}$/.test(transactionId) ||
    typeof excluded !== "boolean"
  ) {
    return NextResponse.json({ error: "Invalid MoneyForward operation" }, { status: 400 });
  }

  const crawlerUrl = process.env.CRAWLER_URL?.trim().replace(/\/+$/, "");
  if (!crawlerUrl) return NextResponse.json({ available: false }, { status: 503 });

  try {
    const response = await fetch(`${crawlerUrl}/operations`, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${process.env.REFRESH_TOKEN ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type, month, transactionId, excluded }),
      signal: AbortSignal.timeout(5_000),
    });
    const result: unknown = await response.json().catch(() => null);
    return NextResponse.json(
      parseCrawlerRefreshStatus(result, response.ok || response.status === 409),
      {
        status: response.status,
      },
    );
  } catch {
    return NextResponse.json({ available: false }, { status: 503 });
  }
}
