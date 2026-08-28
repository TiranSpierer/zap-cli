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
  filters: string[]; allPages: boolean; includeSponsored: boolean;
}): Promise<unknown> {
  const query = args.query.trim();
  if (!query && !args.category) throw new Error("provide a query or --category");
  if (args.filters.length && !args.category) throw new Error("--filter requires --category");
  const first = await searchPage({ ...args, query });
  const models = new Map<string, any>();
  const featuredOffers = new Map<string, any>();
  const sponsored = new Map<string, any>();
  let current = first;
  let page = args.page;
  let previousSignature = "";
  const directModelId = new URL(first.url).searchParams.get("modelid");
  if (directModelId && new URL(first.url).pathname.toLowerCase().endsWith("/model.aspx")) {
    const metadata = await productMetadata(directModelId) as any;
    models.set(directModelId, {
      model_id: directModelId, name: metadata.name, brand: metadata.brand,
      price_from: metadata.price_range?.min, rating: metadata.rating, reviews: metadata.reviews,
      image: metadata.images?.[0], url: metadata.url,
    });
  }
  while (true) {
    const rows = current.$(".model-row-v2.withModelRow");
    rows.each((_, element) => {
      const value = modelSummary(current.$, current.$(element)) as any;
      if (value?.model_id) models.set(value.model_id, value);
    });
    current.$(".model-row-v2.noModelRow").each((_, element) => {
      const row = current.$(element); const value = modelSummary(current.$, row) as any; const offerId = value?.model_id;
      if (!offerId) return;
      const reviewUrl = row.find('a[href*="ratemodel.aspx?modelid="]').first().attr("href");
      featuredOffers.set(offerId, prune({
        offer_id: offerId, name: value.name, brand: value.brand, price: value.price_from, store: row.attr("data-site-name"),
        store_id: row.attr("data-site-id"), store_rating: value.rating, store_reviews: value.reviews, gid: row.attr("data-gid"),
        related_model_id: reviewUrl ? new URL(reviewUrl, BASE_URL).searchParams.get("modelid") : undefined,
        promoted: true, zap_url: `${BASE_URL}/fs.aspx?pid=${offerId}&sog=${row.attr("data-sog")}`,
      }));
    });
    if (args.includeSponsored) current.$(".BidsContainer a[data-bid-id]").each((_, element) => {
      const bid = current.$(element); const offerId = bid.attr("data-bid-id"); if (!offerId) return;
      sponsored.set(offerId, prune({ offer_id: offerId, model_id: bid.attr("data-model-id"), store: bid.attr("data-site-name"), store_id: bid.attr("data-siteid"), brand: bid.attr("data-manufacturer"), product_code: bid.attr("data-pcode"), promoted: true }));
    });
    const signature = [...models.keys()].slice(-rows.length).join(",");
    if (directModelId || !args.allPages || models.size >= args.limit || rows.length === 0 || signature === previousSignature || page >= 50) break;
    previousSignature = signature;
    page++;
    current = await searchPage({ ...args, query, page });
  }
  const totalText = clean(first.$(".categories-count-results").first().text());
  let modelValues = [...models.values()];
  if (args.sort === "price") modelValues.sort((a, b) => (a.price_from ?? Infinity) - (b.price_from ?? Infinity));
  if (args.sort === "price-desc") modelValues.sort((a, b) => (b.price_from ?? -Infinity) - (a.price_from ?? -Infinity));
  const output: Record<string, unknown> = {
    query: query || undefined,
    category: new URL(first.url).searchParams.get("sog") ?? args.category,
    category_name: clean(first.$(".model-title").first().text()) || undefined,
    total_reported: numeric(totalText) ?? models.size + featuredOffers.size,
    page: args.page,
    models: modelValues.slice(0, args.limit),
    store_offers: [...featuredOffers.values()].slice(0, args.limit),
    returned: { models: Math.min(modelValues.length, args.limit), store_offers: Math.min(featuredOffers.size, args.limit) },
    resolved_url: first.url,
  };
  if (args.includeSponsored) output.sponsored_offers = [...sponsored.values()];
  if (!models.size && query.split(/\s+/).length > 1 && !args.category) {
    const fallbackQuery = query.split(/\s+/).slice(0, -1).join(" ");
    const fallback = await searchProducts({ ...args, query: fallbackQuery, allPages: false, includeSponsored: false });
    output.fallback = { query: fallbackQuery, ...(fallback as object) };
  }
  return output;
}

export async function resolveModel(value: string): Promise<string> {
  try { return extractId(value, "modelid"); } catch { /* resolve a natural model name */ }
  const found = await searchProducts({ query: value, page: 1, sort: "popular", limit: 10, filters: [], allPages: false, includeSponsored: false }) as any;
  const models = found.models ?? found.fallback?.models ?? [];
  if (models.length === 1) return models[0].model_id;
  const needle = clean(value).toLowerCase();
  const exact = models.filter((item: any) => clean(item.name).toLowerCase().includes(needle));
  if (exact.length === 1) return exact[0].model_id;
  const choices = models.slice(0, 5).map((item: any) => `${item.model_id}: ${item.name}`).join("; ");
  throw new Error(choices ? `model name is ambiguous; choose an ID: ${choices}` : `no Zap model found for "${value}"`);
}

function personalization($: CheerioAPI): Record<string, unknown> {
  try { return JSON.parse($("#isPersonalization").first().text()); } catch { return {}; }
}

export async function productMetadata(model: string): Promise<unknown> {
  const id = await resolveModel(model);
  const response = await request("/model.aspx", { params: { modelid: id } });
  const $ = load(response.text);
  const raw = personalization($);
  const images = $("#carouselModel .carousel-item img").map((_, element) => $(element).attr("src")).get().filter(Boolean);
  return prune({ model_id: id, name: clean($("h1").first().text()) || raw.Title, brand: raw.Brand, category: raw.SubCategory, category_name: raw.SubCategoryHebName, available: raw.SaleOpen, price_range: { min: raw.MinPrice, max: raw.MaxPrice }, rating: raw.NormalizeRate, reviews: raw.ReviewsAmount, images: [...new Set(images)], url: `${BASE_URL}/model.aspx?modelid=${id}` });
}

function offerFrom($: CheerioAPI, row: Cheerio<AnyNode>, market: string, details: boolean): any {
  const price = numeric(row.attr("data-product-price"));
  const shipping = numeric(row.attr("data-ship-price"));
  const merchantHref = row.find('a[href*="clientcard.aspx?siteid="]').first().attr("href");
  const delivery = row.find(".supply-title").map((_, element) => clean($(element).text())).get().filter(Boolean);
  const official = row.attr("data-official-importer") === "true";
  const parallel = row.attr("data-parallel-importer") === "true";
  const warranty = row.attr("data-warranty-company");
  const zapHref = row.find('a[href*="/fs"], a[href*="shop.zap.co.il/product-model"]').first().attr("href");
  return prune({
    offer_id: row.attr("data-pid"), gid: row.attr("data-gid"), store: row.attr("data-site-name"),
    listing_store_id: row.attr("data-site-id"), merchant_id: merchantHref ? new URL(merchantHref, BASE_URL).searchParams.get("siteid") : undefined,
    price, shipping, total_price: price !== undefined && shipping !== undefined ? price + shipping : price,
    fulfillment: market === "eilat" ? "Eilat purchase/pickup" : "delivery", delivery_days: numeric(row.attr("data-delivery-time")), delivery,
    description: details ? row.attr("data-description") : undefined, tag: row.attr("data-marketing-tags"),
    store_rating: numeric(row.attr("data-total-rank")), store_rating_display: numeric(row.attr("data-site-rate")),
    store_reviews_last_year: numeric(row.attr("data-review-last-year")), store_reviews_total: numeric(row.attr("data-review-total")),
    warranty: warranty && warranty !== "-2" ? warranty : "unknown",
    importer: official ? "official" : parallel ? "parallel" : "unknown",
    official_warranty: row.attr("data-official-warranty") === "true" ? true : undefined,
    market, zap_url: zapHref ? new URL(zapHref, BASE_URL).toString() : undefined,
  });
}

export async function productOffers(model: string, options: { market: string; sort: string; limit: number; details: boolean }): Promise<unknown> {
  const id = await resolveModel(model);
  const response = await request("/model.aspx", { params: { modelid: id, ...(options.market === "eilat" ? { iseilat: "true" } : {}) } });
  const $ = load(response.text);
  const markets: Record<string, unknown[]> = {};
  $(".compare-items-group").each((_, element) => {
    const group = $(element);
    const market = (group.attr("data-group-sale-type-name") ?? "regular").toLowerCase();
    if (options.market !== "all" && options.market !== market) return;
    const raw = group.find(".compare-item-row").map((_, row) => offerFrom($, $(row), market, options.details)).get() as any[];
    const merged = new Map<string, any>();
    for (const offer of raw) {
      const key = offer.offer_id ?? JSON.stringify([offer.store, offer.price, offer.shipping]); const previous = merged.get(key);
      if (!previous) merged.set(key, offer);
      else {
        const conflicts: Record<string, unknown[]> = { ...(previous.data_conflicts ?? {}) };
        for (const field of ["price", "shipping", "total_price", "warranty", "importer"]) {
          if (previous[field] !== undefined && offer[field] !== undefined && previous[field] !== offer[field]) conflicts[field] = [...new Set([previous[field], offer[field]])];
        }
        const richer = offer.merchant_id ? offer : previous;
        merged.set(key, { ...previous, ...richer, ...(Object.keys(conflicts).length ? { data_conflicts: conflicts } : {}) });
      }
    }
    const offers = [...merged.values()];
    if (options.sort === "price") offers.sort((a: any, b: any) => (a.total_price ?? a.price) - (b.total_price ?? b.price));
    markets[market] = offers.slice(0, options.limit);
  });
  if (!(options.market in markets) && options.market !== "all") markets[options.market] = [];
  return { model_id: id, markets, note: Object.values(markets).every((items) => items.length === 0) ? "No offers found for the selected market." : undefined, url: `${BASE_URL}/model.aspx?modelid=${id}` };
}

export async function productSpecs(model: string): Promise<unknown> {
  const id = await resolveModel(model);
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
  const id = await resolveModel(model);
  const payload = JSON.parse((await request("/modelpage/getpricechart", { params: { modelid: id, includepopularity: "true" } })).text);
  const chart = JSON.parse(payload.json ?? "{}");
  const points = (chart.rows ?? []).map((row: any) => prune({ date: row.c?.[0]?.v, price: row.c?.[1]?.v, popularity: row.c?.[2]?.f }));
  return { model_id: id, points };
}

export async function similarProducts(model: string, limit: number): Promise<unknown> {
  const id = await resolveModel(model);
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
  const ids = await Promise.all(models.map(resolveModel));
  if (ids.length < 2 || ids.length > 4) throw new Error("compare requires 2 to 4 models");
  const metadata = await Promise.all(ids.map(productMetadata)) as any[];
  if (new Set(metadata.map((item) => item.category)).size !== 1) throw new Error("Zap compares only models in the same category");
  const specResults = await Promise.all(ids.map(productSpecs)) as any[];
  const flattened = specResults.map((result) => Object.fromEntries((result.sections ?? []).flatMap((section: any) => (section.specs ?? []).map((spec: any) => [spec.name, spec.value]))));
  const names = [...new Set(flattened.flatMap((item) => Object.keys(item)))];
  const differences = names.map((name) => ({ spec: name, values: Object.fromEntries(ids.map((id, index) => [id, flattened[index][name] ?? "unknown"])) })).filter((row) => new Set(Object.values(row.values)).size > 1);
  return { category: metadata[0].category, models: metadata.map(({ images, ...item }) => item), differences, url: `${BASE_URL}/compare.aspx?sog=${metadata[0].category}&modelsid=${ids.join(",")}` };
}

export async function localStores(model: string): Promise<unknown> {
  const id = await resolveModel(model); const $ = load((await request("/modelofflinestores.aspx", { params: { modelid: id } })).text);
  return { model_id: id, offers: $(".compare-item-row").map((_, row) => offerFrom($, $(row), "local", false)).get(), url: `${BASE_URL}/modelofflinestores.aspx?modelid=${id}` };
}

export async function rawProductPage(model: string, resource: string): Promise<unknown> {
  const id = await resolveModel(model);
  const paths: Record<string, string> = { model: "/model.aspx", specs: "/compmodels.aspx", reviews: "/ratemodel.aspx", "local-stores": "/modelofflinestores.aspx" };
  const response = await request(paths[resource], { params: { modelid: id } });
  const directory = join(tmpdir(), "zap-cli", id); await mkdir(directory, { recursive: true });
  const path = join(directory, `${resource}.html`); await writeFile(path, response.buffer);
  return { model_id: id, resource, path, url: response.url };
}
