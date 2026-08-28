import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

export const BASE_URL = "https://www.zap.co.il";

export function clean(value: unknown): string {
  return String(value ?? "").replace(/[\u200e\u200f]/g, "").replace(/\s+/g, " ").trim();
}

export function numeric(value: unknown): number | undefined {
  const match = clean(value).replace(/[,₪]/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const result = Number(match[0]);
  return Number.isFinite(result) ? result : undefined;
}

export function extractId(value: string, parameter: "modelid" | "siteid"): string {
  let result = value.trim();
  if (result.startsWith("http://") || result.startsWith("https://")) {
    result = new URL(result).searchParams.get(parameter) ?? "";
  }
  if (!/^\d+$/.test(result)) throw new Error(`${parameter === "modelid" ? "model" : "store"} must be a numeric Zap ID or URL`);
  return result;
}

export function text($: CheerioAPI, node: Cheerio<AnyNode>, selector: string): string | undefined {
  const result = clean(node.find(selector).first().text());
  return result || undefined;
}

export function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    const result = value.map(prune).filter((item) => item !== undefined);
    return result.length ? result : undefined;
  }
  if (value && typeof value === "object") {
    const result = Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const cleaned = prune(item);
      return cleaned === undefined ? [] : [[key, cleaned]];
    }));
    return Object.keys(result).length ? result : undefined;
  }
  return value === undefined || value === null || value === "" ? undefined : value;
}
