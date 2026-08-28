import { load } from "cheerio";
import { request } from "./client.js";
import { BASE_URL, clean, extractId, numeric, prune } from "./common.js";

export async function searchStores(query: string, limit: number): Promise<unknown> {
  const $ = load((await request("/modelsstore.aspx", { params: { sog: "g-stores", keyword: query } })).text);
  const stores = $(".compare-item-row[data-site-id]").slice(0, limit).map((_, element) => {
    const row = $(element); const id = row.attr("data-site-id"); const link = row.find('a[href*="clientcard.aspx?siteid="]').first();
    return prune({ store_id: id, name: clean(row.find(".product-name, .store-name, h2, h3").first().text()) || clean(link.attr("aria-label")), rating: numeric(row.find(".rate-score, .num").first().text()), url: id ? `${BASE_URL}/clientcard.aspx?siteid=${id}` : undefined });
  }).get();
  return { query, stores };
}

async function resolveStore(value: string): Promise<string> {
  try { return extractId(value, "siteid"); } catch { /* resolve by directory */ }
  const result = await searchStores(value, 10) as any; const stores = result.stores ?? [];
  if (stores.length === 1) return stores[0].store_id;
  const needle = clean(value).toLowerCase(); const exact = stores.filter((item: any) => clean(item.name).toLowerCase().includes(needle));
  if (exact.length === 1) return exact[0].store_id;
  throw new Error(stores.length ? `store name is ambiguous; choose an ID: ${stores.map((item: any) => `${item.store_id}: ${item.name}`).join("; ")}` : `no Zap store found for "${value}"`);
}

export async function storeMetadata(store: string): Promise<unknown> {
  const id = await resolveStore(store); const $ = load((await request("/clientcard.aspx", { params: { siteid: id } })).text); const page = $(".clientcard-page").first();
  if (!page.length) throw new Error("Store not found on Zap");
  const stats = page.find(".stat-num").map((_, element) => clean($(element).text())).get(); const contact: Record<string, string> = {};
  page.find("[data-cc-reveal]").each((_, element) => { const item = $(element); const label = clean(item.closest(".fact").find("span").first().text()).replace(/:$/, ""); const value = item.attr("data-value"); if (label && value) contact[label] = value; });
  return prune({ store_id: id, name: clean(page.find(".client-name").first().text()), tagline: clean(page.find(".client-tagline").first().text()), rating: numeric(page.find(".rating-pill .num").first().text()), reviews_last_year: numeric(stats[1]), reviews_total: numeric(stats[2]), since: clean(page.find(".since-zap").first().text()), contact, categories: page.find(".also-find-under-list a").map((_, element) => clean($(element).text())).get(), url: `${BASE_URL}/clientcard.aspx?siteid=${id}` });
}

export async function storeReviews(store: string, page: number, limit: number): Promise<unknown> {
  const id = await resolveStore(store); const $ = load((await request("/clientcard.aspx", { params: { siteid: id, pageinfo: page } })).text);
  const reviews = $(".review-card").slice(0, limit).map((_, element) => { const node = $(element); return prune({ review_id: node.attr("data-review-id"), author: clean(node.find(".reviewer-name").text()), date: clean(node.find(".reviewer-date").text()), product: clean(node.find(".product-meta .val").text()), body: clean(node.find(".review-text").text()), helpful: numeric(node.find('[data-helpful="true"] .count').text()), not_helpful: numeric(node.find('[data-helpful="false"] .count').text()) }); }).get();
  let total = numeric($(".reviews-count").first().text());
  if (total === undefined) total = (await storeMetadata(id) as any).reviews_total;
  return { store_id: id, total: total ?? reviews.length, returned: reviews.length, page, reviews, note: !reviews.length && page > 1 ? "No reviews on this page; it may be beyond the available range." : undefined, url: `${BASE_URL}/clientcard.aspx?siteid=${id}` };
}
