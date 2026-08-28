import iconv from "iconv-lite";
import { BASE_URL } from "./common.js";

const SERVICE_URL = "https://service.zap.co.il";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const cookies = new Map<string, string>();

function cookieHeader(): string {
  return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
}

function rememberCookies(response: Response): void {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

export async function request(
  path: string,
  options: { params?: Record<string, string | number | undefined>; body?: unknown; service?: boolean } = {},
): Promise<{ buffer: Buffer; text: string; url: string; contentType: string }> {
  const base = options.service ? SERVICE_URL : BASE_URL;
  let url = new URL(path, base);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  let body = options.body === undefined ? undefined : JSON.stringify(options.body);
  for (let redirects = 0; redirects <= 8; redirects++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/json",
          "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
          ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body,
      });
    } catch (error) {
      throw new Error(`Could not reach Zap: ${error instanceof Error ? error.message : String(error)}`);
    }
    rememberCookies(response);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Zap redirect ${response.status} had no location`);
      url = new URL(location.replace(/ /g, "%20"), url);
      if (response.status === 303) body = undefined;
      continue;
    }
    if (response.status === 404) throw new Error("Zap resource not found");
    if (!response.ok) throw new Error(`Zap returned HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    const charset = contentType.match(/charset=([^;\s]+)/i)?.[1]?.replaceAll('"', "").toLowerCase() ?? "utf-8";
    const text = iconv.decode(buffer, charset === "windows-1255" ? "win1255" : charset);
    return { buffer, text, url: url.toString(), contentType };
  }
  throw new Error("Zap redirected too many times");
}
