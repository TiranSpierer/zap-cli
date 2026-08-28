import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { request } from "./client.js";
import { BASE_URL, clean, extractId, numeric, prune, text } from "./common.js";

const SORTS: Record<string, string> = { new: "snum", price: "price", "price-desc": "price_desc", rating: "rate", reviews: "ratesum" };

function modelSummary($: CheerioAPI, row: Cheerio<AnyNode>): unknown {
  const id = row.attr("data-model-id");
  const storesText = text($, row, ".card-v2__stores-link");
  return prune({
    model_id: id,
    name: text($, row, ".card-v2__title a"),
    brand: row.attr("data-manufacturer"),
    price_from: numeric(text($, row, ".card-v2__price-amount")),
    stores: storesText ? Math.abs(numeric(storesText) ?? 0) : undefined,
    rating: numeric(text($, row, ".card-v2__rate-score")),
    reviews: numeric(text($, row, ".card-v2__rate-count")),
    image: row.find(".card-v2__image img").first().attr("src"),
    url: id ? `${BASE_URL}/model.aspx?modelid=${id}` : undefined,
  });
}

async function searchPage(args: {
  query: string; category?: string; page: number; sort: string; filters: string[];
}): Promise<{ $: CheerioAPI; url: string }> {
  const params: Record<string, string | number> = {};
  if (args.page > 1) params.pageinfo = args.page;
  if (args.sort !== "popular") params.orderby = SORTS[args.sort];
  if (args.category) {
    params.sog = args.category;
    if (args.query) params.keyword = args.query;
    for (const filter of args.filters) {
      const [rawGroup, value] = filter.split("=", 2);
      const group = rawGroup?.replace(/^db/, "");
      if (!group || !/^\d+$/.test(group) || !value) throw new Error("filters must use GROUP=OPTION[,OPTION]");
      params[`db${group}`] = value;
    }
  } else {
    params.keyword = args.query;
  }
  const response = await request(args.category ? "/models.aspx" : "/search.aspx", { params });
  return { $: load(response.text), url: response.url };
}

export async function searchProducts(args: {
  query: string; category?: string; page: number; sort: string; limit: number;
  filters: string[]; allPages: boolean; includePromoted: boolean;
}): Promise<unknown> {
  const query = args.query.trim();
  if (!query && !args.category) throw new Error("provide a query or --category");
  if (args.filters.length && !args.category) throw new Error("--filter requires --category");
  const first = await searchPage({ ...args, query });
  const summaries: unknown[] = [];
  let current = first;
  let page = args.page;
  while (true) {
    const rows = current.$(".model-row-v2.withModelRow");
    rows.each((_, element) => { summaries.push(modelSummary(current.$, current.$(element))); });
    if (!args.allPages || summaries.length >= args.limit || rows.length === 0) break;
    page++;
    current = await searchPage({ ...args, query, page });
  }
  const totalText = clean(first.$(".categories-count-results").first().text());
  const output: Record<string, unknown> = {
    query: query || undefined,
    category: new URL(first.url).searchParams.get("sog") ?? args.category,
    category_name: clean(first.$(".model-title").first().text()) || undefined,
    total: numeric(totalText) ?? summaries.length,
    page: args.page,
    results: summaries.slice(0, args.limit),
    resolved_url: first.url,
  };
  if (args.includePromoted) {
    const featured: unknown[] = [];
    first.$(".model-row-v2.noModelRow").each((_, element) => {
      const row = first.$(element);
      const value = modelSummary(first.$, row) as Record<string, unknown>;
      const offerId = value.model_id;
      delete value.model_id;
      delete value.stores;
      const reviewUrl = row.find('a[href*="ratemodel.aspx?modelid="]').first().attr("href");
      featured.push(prune({ offer_id: offerId, ...value, store: row.attr("data-site-name"), store_id: row.attr("data-site-id"), gid: row.attr("data-gid"), related_model_id: reviewUrl ? new URL(reviewUrl, BASE_URL).searchParams.get("modelid") : undefined }));
    });
    const bids: unknown[] = [];
    first.$(".BidsContainer a[data-bid-id]").each((_, element) => {
      const bid = first.$(element);
      bids.push(prune({ offer_id: bid.attr("data-bid-id"), model_id: bid.attr("data-model-id"), store: bid.attr("data-site-name"), store_id: bid.attr("data-siteid"), brand: bid.attr("data-manufacturer"), product_code: bid.attr("data-pcode") }));
    });
    output.promoted = { featured_offers: featured, sponsored_bids: bids };
  }
  return prune(output);
}

function personalization($: CheerioAPI): Record<string, unknown> {
  try { return JSON.parse($("#isPersonalization").first().text()); } catch { return {}; }
}

export async function productMetadata(model: string): Promise<unknown> {
  const id = extractId(model, "modelid");
  const response = await request("/model.aspx", { params: { modelid: id } });
  const $ = load(response.text);
  const raw = personalization($);
  const images = $("#carouselModel .carousel-item img").map((_, element) => $(element).attr("src")).get().filter(Boolean);
  return prune({ model_id: id, name: clean($("h1").first().text()) || raw.Title, brand: raw.Brand, category: raw.SubCategory, category_name: raw.SubCategoryHebName, available: raw.SaleOpen, price_range: { min: raw.MinPrice, max: raw.MaxPrice }, rating: raw.NormalizeRate, reviews: raw.ReviewsAmount, images: [...new Set(images)], url: `${BASE_URL}/model.aspx?modelid=${id}` });
}

function offerFrom($: CheerioAPI, row: Cheerio<AnyNode>, market: string): unknown {
  const price = numeric(row.attr("data-product-price"));
  const shipping = numeric(row.attr("data-ship-price"));
  const merchantHref = row.find('a[href*="clientcard.aspx?siteid="]').first().attr("href");
  const delivery = row.find(".supply-title").map((_, element) => clean($(element).text())).get().filter(Boolean);
  return prune({
    offer_id: row.attr("data-pid"), gid: row.attr("data-gid"), store: row.attr("data-site-name"),
    listing_store_id: row.attr("data-site-id"), merchant_id: merchantHref ? new URL(merchantHref, BASE_URL).searchParams.get("siteid") : undefined,
    price, shipping, delivered_price: market === "regular" && price !== undefined && shipping !== undefined ? price + shipping : undefined,
    delivery, description: row.attr("data-description"), tag: row.attr("data-marketing-tags"),
    store_rating: numeric(row.attr("data-total-rank")), store_rating_display: numeric(row.attr("data-site-rate")),
    store_reviews_last_year: numeric(row.attr("data-review-last-year")), store_reviews_total: numeric(row.attr("data-review-total")),
    warranty_raw: row.attr("data-warranty-company"), warranty_value_raw: row.attr("data-warranty-months"),
    official_warranty: row.attr("data-official-warranty") === "true", official_importer: row.attr("data-official-importer") === "true",
    parallel_importer: row.attr("data-parallel-importer") === "true", market,
  });
}

export async function productOffers(model: string, options: { market: string; sort: string }): Promise<unknown> {
  const id = extractId(model, "modelid");
  const response = await request("/model.aspx", { params: { modelid: id, ...(options.market === "eilat" ? { iseilat: "true" } : {}) } });
  const $ = load(response.text);
  const markets: Record<string, unknown[]> = {};
  $(".compare-items-group").each((_, element) => {
    const group = $(element);
    const market = (group.attr("data-group-sale-type-name") ?? "regular").toLowerCase();
    if (options.market !== "all" && options.market !== market) return;
    const offers = group.find(".compare-item-row").map((_, row) => offerFrom($, $(row), market)).get();
    if (options.sort === "price") offers.sort((a: any, b: any) => (a.delivered_price ?? a.price) - (b.delivered_price ?? b.price));
    markets[market] = offers;
  });
  return { model_id: id, markets, url: `${BASE_URL}/model.aspx?modelid=${id}` };
}

export async function productSpecs(model: string): Promise<unknown> {
  const id = extractId(model, "modelid");
  const $ = load((await request("/compmodels.aspx", { params: { modelid: id } })).text);
  const sections: Array<{ section: string; specs: unknown[] }> = [];
  let current: { section: string; specs: unknown[] } = { section: "General", specs: [] };
  $(".specificationContainer .specificationTitle, .specificationContainer .paramRow").each((_, element) => {
    const node = $(element);
    if (node.hasClass("specificationTitle")) {
      if (current.specs.length) sections.push(current);
      current = { section: clean(node.text()), specs: [] };
    } else {
      const label = clean(node.children(".ParamCol").clone().children().remove().end().text()) || clean(node.find(".ParamCol .title").first().text());
      const value = clean(node.children(".ParamColValue").text());
      if (label && value) current.specs.push({ name: label, value });
    }
  });
  if (current.specs.length) sections.push(current);
  return { model_id: id, sections, url: `${BASE_URL}/compmodels.aspx?modelid=${id}` };
}

export async function productHistory(model: string): Promise<unknown> {
  const id = extractId(model, "modelid");
  const payload = JSON.parse((await request("/modelpage/getpricechart", { params: { modelid: id, includepopularity: "true" } })).text);
  const chart = JSON.parse(payload.json ?? "{}");
  const points = (chart.rows ?? []).map((row: any) => prune({ date: row.c?.[0]?.v, price: row.c?.[1]?.v, popularity: row.c?.[2]?.f }));
  return { model_id: id, points };
}

export async function similarProducts(model: string, limit: number): Promise<unknown> {
  const id = extractId(model, "modelid");
  const $ = load((await request("/modelpage/getsimilarproductsslider", { params: { title: "similar", modelid: id, pagename: "model" } })).text);
  const results = $(".card-v2[data-model-id]").slice(0, limit).map((_, element) => {
    const card = $(element); const cid = card.attr("data-model-id");
    return prune({ model_id: cid, name: text($, card, ".card-v2__title a"), price_from: numeric(card.attr("data-price")), rating: numeric(card.attr("data-model-rate")), url: `${BASE_URL}/model.aspx?modelid=${cid}` });
  }).get();
  return { model_id: id, results };
}

export async function productImages(model: string): Promise<unknown> {
  const metadata = await productMetadata(model) as any; const id = metadata.model_id as string;
  const directory = join(tmpdir(), "zap-cli", id); await mkdir(directory, { recursive: true });
  const paths = (await Promise.all((metadata.images ?? []).map(async (url: string, index: number) => {
    try { const response = await request(url); const path = join(directory, `${id}_${index + 1}${extname(new URL(url).pathname) || ".jpg"}`); await writeFile(path, response.buffer); return path; } catch { return undefined; }
  }))).filter(Boolean);
  return { model_id: id, count: paths.length, images: paths };
}

export async function compareProducts(models: string[]): Promise<unknown> {
  const ids = models.map((value) => extractId(value, "modelid"));
  if (ids.length < 2 || ids.length > 4) throw new Error("compare requires 2 to 4 models");
  const metadata = await Promise.all(ids.map(productMetadata)) as any[];
  if (new Set(metadata.map((item) => item.category)).size !== 1) throw new Error("Zap compares only models in the same category");
  const specifications = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await productSpecs(id) as any).sections])));
  return { category: metadata[0].category, models: metadata, specifications, url: `${BASE_URL}/compare.aspx?sog=${metadata[0].category}&modelsid=${ids.join(",")}` };
}

export async function localStores(model: string): Promise<unknown> {
  const id = extractId(model, "modelid"); const $ = load((await request("/modelofflinestores.aspx", { params: { modelid: id } })).text);
  return { model_id: id, offers: $(".compare-item-row").map((_, row) => offerFrom($, $(row), "local")).get(), url: `${BASE_URL}/modelofflinestores.aspx?modelid=${id}` };
}
