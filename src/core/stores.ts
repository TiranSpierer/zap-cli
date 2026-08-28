import { load } from "cheerio";
import { request } from "./client.js";
import { BASE_URL, clean, extractId, numeric, prune } from "./common.js";

export async function storeMetadata(store: string): Promise<unknown> {
  const id = extractId(store, "siteid"); const $ = load((await request("/clientcard.aspx", { params: { siteid: id } })).text); const page = $(".clientcard-page").first();
  if (!page.length) throw new Error("Store not found on Zap");
  const stats = page.find(".stat-num").map((_, element) => clean($(element).text())).get(); const contact: Record<string, string> = {};
  page.find("[data-cc-reveal]").each((_, element) => { const item = $(element); const label = clean(item.closest(".fact").find("span").first().text()).replace(/:$/, ""); const value = item.attr("data-value"); if (label && value) contact[label] = value; });
  return prune({ store_id: id, name: clean(page.find(".client-name").first().text()), tagline: clean(page.find(".client-tagline").first().text()), rating: numeric(page.find(".rating-pill .num").first().text()), reviews_last_year: numeric(stats[1]), reviews_total: numeric(stats[2]), since: clean(page.find(".since-zap").first().text()), contact, categories: page.find(".also-find-under-list a").map((_, element) => clean($(element).text())).get(), url: `${BASE_URL}/clientcard.aspx?siteid=${id}` });
}

export async function storeReviews(store: string, page: number, limit: number): Promise<unknown> {
  const id = extractId(store, "siteid"); const $ = load((await request("/clientcard.aspx", { params: { siteid: id, pageinfo: page } })).text);
  const reviews = $(".review-card").slice(0, limit).map((_, element) => { const node = $(element); return prune({ review_id: node.attr("data-review-id"), author: clean(node.find(".reviewer-name").text()), date: clean(node.find(".reviewer-date").text()), product: clean(node.find(".product-meta .val").text()), body: clean(node.find(".review-text").text()), helpful: numeric(node.find('[data-helpful="true"] .count').text()), not_helpful: numeric(node.find('[data-helpful="false"] .count').text()) }); }).get();
  return { store_id: id, total: numeric($(".reviews-count").first().text()) ?? reviews.length, page, reviews, url: `${BASE_URL}/clientcard.aspx?siteid=${id}` };
}
