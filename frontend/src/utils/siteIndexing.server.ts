import { type NextRequest, NextResponse } from "next/server";

export type SiteConfigRow = {
  key: string;
  value?: string | null;
  defaultValue?: string | null;
  type?: string;
};

const CACHE_TTL = 5_000;
const ROBOTS_TAG = "noindex, nofollow, noarchive";
let rows: SiteConfigRow[] = [];
let current: { expiresAt: number; result: Promise<SiteConfig> } | undefined;

type SiteConfig = { rows: SiteConfigRow[]; blockIndexing: boolean };

export function readSiteConfig(): Promise<SiteConfig> {
  const now = Date.now();
  if (!current || current.expiresAt <= now) {
    current = { expiresAt: now + CACHE_TTL, result: fetchSiteConfig() };
  }
  return current.result;
}

async function fetchSiteConfig(): Promise<SiteConfig> {
  const origin = process.env.API_URL || "http://127.0.0.1:8080";
  try {
    const response = await fetch(`${origin}/api/configs`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return { rows, blockIndexing: true };
    const data: unknown = await response.json();
    if (
      !Array.isArray(data) ||
      data.some((row) => typeof row?.key !== "string")
    ) {
      return { rows, blockIndexing: true };
    }
    const setting = data.find((row) => row.key === "general.disableIndexing");
    rows = data;
    return {
      rows,
      blockIndexing: String(setting?.value ?? setting?.defaultValue) === "true",
    };
  } catch {
    return { rows, blockIndexing: true };
  }
}

export function siteIndexingResponse(
  request: NextRequest,
  response = NextResponse.next(),
) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/robots.txt") {
    // Robots need to crawl the URLs to see their noindex response headers.
    response = new NextResponse("User-agent: *\nDisallow:\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } else if (pathname === "/sitemap.xml") {
    response = new NextResponse(null, { status: 404 });
  }
  response.headers.set("X-Robots-Tag", ROBOTS_TAG);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
