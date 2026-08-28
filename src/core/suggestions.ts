import { request } from "./client.js";
import { clean, prune } from "./common.js";

export async function suggestions(query: string, limit: number): Promise<unknown> {
  if (!query.trim()) throw new Error("query must not be empty");
  const payload = JSON.parse((await request("/getsearchmultiplesuggestions.ashx", { service: true, body: { keyword: query, sogId: 0, sogName: "", isMarketPlace: false } })).text);
  return { query, results: (payload.result ?? []).filter((item: any) => item.Description && item.Url).slice(0, limit).map((item: any) => prune({ text: clean(item.Description), description: clean(item.ExtraDescription), category: item.Category, type: item.SuggestType, url: item.Url })) };
}
