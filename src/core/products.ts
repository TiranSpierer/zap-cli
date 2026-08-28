import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { request } from "./client.js";
import { BASE_URL, clean, extractId, numeric, prune, text } from "./common.js";
import { categoryFilters, listCategories } from "./categories.js";

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
  if (args.category && args.filters.length) args = { ...args, filters: await resolveFilters(args.category, query || undefined, args.filters) };
  const first = await searchPage({ ...args, query });
  if (args.category) {
    const resolved = new URL(first.url);
    for (const filter of args.filters) {
      const [group, value] = filter.split("=", 2); const actual = resolved.searchParams.get(`db${group.replace(/^db/, "")}`);
      if (!actual || new Set(actual.split(",")).size !== new Set(value.split(",")).size || value.split(",").some((item) => !actual.split(",").includes(item))) throw new Error(`Zap rejected filter ${filter}; refresh category filters`);
    }
  }
  const models = new Map<string, any>();
  const searchTexts = new Map<string, string>();
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
      price_from: metadata.comparable_offer_range?.min ?? metadata.price_range_reported_by_zap?.min, rating: metadata.rating, reviews: metadata.reviews,
      image: metadata.images?.[0], url: metadata.url,
    });
  }
  while (true) {
    const rows = current.$(".model-row-v2.withModelRow");
    rows.each((_, element) => {
      const value = modelSummary(current.$, current.$(element)) as any;
      if (value?.model_id) { models.set(value.model_id, value); searchTexts.set(value.model_id, clean(current.$(element).find(".card-v2__row-params").text())); }
    });
    current.$(".model-row-v2.noModelRow").each((_, element) => {
      const row = current.$(element); const value = modelSummary(current.$, row) as any; const offerId = value?.model_id;
      if (!offerId) return;
      const reviewUrl = row.find('a[href*="ratemodel.aspx?modelid="]').first().attr("href");
      featuredOffers.set(row.attr("data-gid") || offerId, prune({
        offer_id: offerId, name: value.name, brand: value.brand, price: value.price_from, store: row.attr("data-site-name"),
        store_id: row.attr("data-site-id"), store_rating: value.rating, store_reviews: value.reviews, gid: row.attr("data-gid"),
        related_model_id: reviewUrl ? new URL(reviewUrl, BASE_URL).searchParams.get("modelid") : undefined,
        zap_url: `${BASE_URL}/fs.aspx?pid=${offerId}&sog=${row.attr("data-sog")}`,
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
  if (args.sort === "popular" && query) {
    const tokens = clean(query).toLowerCase().split(/\s+/).filter((token) => token.length > 1);
    const score = (item: any) => { const name = `${clean(item.name)} ${searchTexts.get(item.model_id) ?? ""}`.toLowerCase(); const penalties = ["pro", "max", "ultra", "plus", " ti"].filter((token) => name.includes(token) && !clean(query).toLowerCase().includes(token.trim())).length; return (name.includes(clean(query).toLowerCase()) ? 100 : 0) + tokens.filter((token) => name.includes(token)).length - penalties * 2; };
    modelValues.sort((a, b) => score(b) - score(a));
  }
  if (args.sort === "price") modelValues.sort((a, b) => (a.price_from ?? Infinity) - (b.price_from ?? Infinity));
  if (args.sort === "price-desc") modelValues.sort((a, b) => (b.price_from ?? -Infinity) - (a.price_from ?? -Infinity));
  const storeOfferValues = [...featuredOffers.values()];
  if (args.sort === "price") storeOfferValues.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  if (args.sort === "price-desc") storeOfferValues.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
  const output: Record<string, unknown> = {
    query: query || undefined,
    category: new URL(first.url).searchParams.get("sog") ?? args.category,
    category_name: clean(first.$(".model-title").first().text()) || undefined,
    total_reported: numeric(totalText) ?? models.size + featuredOffers.size,
    page: args.page,
    models: modelValues.slice(0, args.limit),
    store_offers: storeOfferValues.slice(0, args.limit),
    returned: { models: Math.min(modelValues.length, args.limit), store_offers: Math.min(featuredOffers.size, args.limit) },
    resolved_url: first.url,
    note: !models.size && !featuredOffers.size ? "No products found." : undefined,
  };
  if (args.includeSponsored) output.sponsored_offers = [...sponsored.values()];
  const queryTokens = clean(query).split(/\s+/).filter((token) => token.length >= 3);
  const anchorToken = /^[\x00-\x7F]+$/.test(query) ? queryTokens[0] : queryTokens.at(-1);
  const edgeMatched = !anchorToken || modelValues.some((item) => clean(item.name).toLowerCase().includes(anchorToken.toLowerCase()));
  if (!args.category && queryTokens.length > 1 && (!models.size || !edgeMatched)) {
    const resolvedCategory = new URL(first.url).searchParams.get("sog");
    if (resolvedCategory && anchorToken) {
      output.category_fallback = await searchProducts({ ...args, query: anchorToken, category: resolvedCategory, allPages: false, includeSponsored: false });
    } else {
      const catalog = await listCategories() as any;
      const candidates = (catalog.groups ?? []).flatMap((group: any) => group.categories ?? []).map((category: any) => ({ ...category, score: queryTokens.filter((token) => `${category.code} ${category.name}`.toLowerCase().includes(token.toLowerCase())).length })).filter((category: any) => category.score > 0).sort((a: any, b: any) => b.score - a.score);
      if (candidates.length && candidates[0].score > (candidates[1]?.score ?? 0)) {
        const categoryText = `${candidates[0].code} ${candidates[0].name}`.toLowerCase();
      const remaining = queryTokens.filter((token) => !categoryText.includes(token.toLowerCase()));
      const keyword = /^[\x00-\x7F]+$/.test(query) ? remaining[0] : remaining.at(-1);
      if (keyword) output.category_fallback = await searchProducts({ ...args, query: keyword, category: candidates[0].code, allPages: false, includeSponsored: false });
      }
    }
  }
  if (!models.size && query.split(/\s+/).length > 1 && !args.category && !output.category_fallback) {
    const fallbackQuery = query.split(/\s+/).slice(0, -1).join(" ");
    const fallback = await searchProducts({ ...args, query: fallbackQuery, allPages: false, includeSponsored: false });
    output.fallback = { query: fallbackQuery, ...(fallback as object) };
  }
  return output;
}

async function resolveFilters(category: string, query: string | undefined, filters: string[]): Promise<string[]> {
  if (filters.every((filter) => /^(?:db)?\d+=/.test(filter))) return filters;
  const data = await categoryFilters(category, query, false) as any;
  const aliases: Record<string, string> = { brand: "מותג", price: "טווח מחירים" };
  return filters.map((filter) => {
    const [requestedGroup, requestedValue] = filter.split("=", 2);
    if (!requestedGroup || !requestedValue) throw new Error("filters must use GROUP=OPTION[,OPTION]");
    const groupName = aliases[requestedGroup.toLowerCase()] ?? requestedGroup;
    const group = (data.filter_groups ?? []).find((item: any) => clean(item.name).toLowerCase() === clean(groupName).toLowerCase() || item.id === requestedGroup.replace(/^db/, ""));
    if (!group) throw new Error(`unknown filter group "${requestedGroup}"; run category filters first`);
    const values = requestedValue.split(",").map((value) => {
      const option = group.options.find((item: any) => item.id === value || clean(item.name).toLowerCase() === clean(value).toLowerCase());
      if (!option) throw new Error(`unknown ${group.name} option "${value}"; run category filters first`);
      return option.id;
    });
    return `${group.id}=${values.join(",")}`;
  });
}

export async function resolveModel(value: string): Promise<string> {
  try { return extractId(value, "modelid"); } catch { /* resolve a natural model name */ }
  const found = await searchProducts({ query: value, page: 1, sort: "popular", limit: 10, filters: [], allPages: false, includeSponsored: false }) as any;
  const models = found.models ?? found.fallback?.models ?? [];
  if (models.length === 1) return models[0].model_id;
  const needle = clean(value).toLowerCase();
  const exact = models.filter((item: any) => clean(item.name).toLowerCase().includes(needle));
  if (exact.length === 1) return exact[0].model_id;
  if (exact.length > 1) return exact.sort((a: any, b: any) => clean(a.name).length - clean(b.name).length)[0].model_id;
  const tokens = needle.split(/\s+/).filter((token) => token.length > 1);
  const ranked = models.map((item: any) => ({ item, score: tokens.filter((token) => clean(item.name).toLowerCase().includes(token)).length })).sort((a: any, b: any) => b.score - a.score);
  if (ranked[0]?.score > (ranked[1]?.score ?? 0)) return ranked[0].item.model_id;
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
  const offerPrices = [...new Set($(".compare-items-group[data-group-sale-type-name='Regular'] .compare-item-row").map((_, element) => numeric($(element).attr("data-product-price"))).get().filter((value): value is number => value !== undefined))].sort((a, b) => a - b);
  const median = offerPrices[Math.floor(offerPrices.length / 2)];
  const comparable = median && offerPrices.length >= 3 ? offerPrices.filter((price) => price >= median * 0.35) : offerPrices;
  return prune({ model_id: id, name: clean($("h1").first().text()) || raw.Title, brand: raw.Brand, category: raw.SubCategory, category_name: raw.SubCategoryHebName, available: raw.SaleOpen, price_range_reported_by_zap: { min: raw.MinPrice, max: raw.MaxPrice }, comparable_offer_range: comparable.length ? { min: Math.min(...comparable), max: Math.max(...comparable) } : undefined, price_anomalies_detected: offerPrices.length - comparable.length || undefined, rating: raw.NormalizeRate, reviews: raw.ReviewsAmount, images: [...new Set(images)], url: `${BASE_URL}/model.aspx?modelid=${id}` });
}

function offerFrom($: CheerioAPI, row: Cheerio<AnyNode>, market: string, details: boolean): any {
  const price = numeric(row.attr("data-product-price"));
  const shippingRaw = numeric(row.attr("data-ship-price"));
  const shipping = shippingRaw !== undefined && shippingRaw >= 0 ? shippingRaw : undefined;
  const deliveryDaysRaw = numeric(row.attr("data-delivery-time"));
  const merchantHref = row.find('a[href*="clientcard.aspx?siteid="]').first().attr("href");
  const delivery = row.find(".supply-title").map((_, element) => clean($(element).text())).get().filter(Boolean);
  const official = row.attr("data-official-importer") === "true";
  const parallel = row.attr("data-parallel-importer") === "true";
  const warranty = row.attr("data-warranty-company");
  const warrantyLabel = !warranty || warranty === "-2" ? "unknown" : /^\d+$/.test(warranty) ? `${warranty} (unit not provided by Zap)` : warranty;
  const zapHref = row.find('a[href*="/fs"], a[href*="shop.zap.co.il/product-model"]').first().attr("href");
  return prune({
    offer_id: row.attr("data-pid"), gid: row.attr("data-gid"), store: row.attr("data-site-name"),
    listing_store_id: row.attr("data-site-id"), merchant_id: merchantHref ? new URL(merchantHref, BASE_URL).searchParams.get("siteid") : undefined,
    price, shipping, total_price: price !== undefined && shipping !== undefined ? price + shipping : price,
    fulfillment: market === "eilat" ? "Eilat purchase/pickup" : "delivery", delivery_days: deliveryDaysRaw !== undefined && deliveryDaysRaw >= 0 ? deliveryDaysRaw : undefined, delivery,
    description: details ? row.attr("data-description") : undefined, tags: row.attr("data-marketing-tags") ? [row.attr("data-marketing-tags")] : undefined,
    store_rating: numeric(row.attr("data-total-rank")), store_rating_display: numeric(row.attr("data-site-rate")),
    store_reviews_last_year: numeric(row.attr("data-review-last-year")), store_reviews_total: numeric(row.attr("data-review-total")),
    warranty: warrantyLabel,
    importer: official ? "official" : parallel ? "parallel" : "unknown",
    official_warranty: row.attr("data-official-warranty") === "true" ? true : undefined,
    market, zap_url: zapHref ? new URL(zapHref, BASE_URL).toString() : undefined,
  });
}

export async function productOffers(model: string, options: { market: string; sort: string; limit: number; details: boolean; includeAnomalies: boolean }): Promise<unknown> {
  const id = await resolveModel(model);
  const response = await request("/model.aspx", { params: { modelid: id, ...(options.market === "eilat" ? { iseilat: "true" } : {}) } });
  const $ = load(response.text);
  const markets: Record<string, unknown[]> = {};
  const anomaliesExcluded: Record<string, number> = {};
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
        const tags = [...new Set([...(previous.tags ?? []), ...(offer.tags ?? [])])];
        merged.set(key, { ...previous, ...richer, ...(tags.length ? { tags } : {}), ...(Object.keys(conflicts).length ? { data_conflicts: conflicts } : {}) });
      }
    }
    let offers = [...merged.values()];
    const prices = offers.map((offer) => offer.total_price).filter((price): price is number => typeof price === "number").sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const anomalous = median && prices.length >= 3 ? offers.filter((offer) => offer.total_price < median * 0.35) : [];
    for (const offer of anomalous) offer.possible_mismatch = true;
    if (!options.includeAnomalies) offers = offers.filter((offer) => !offer.possible_mismatch);
    if (options.sort === "price") offers.sort((a: any, b: any) => (a.total_price ?? a.price) - (b.total_price ?? b.price));
    markets[market] = offers.slice(0, options.limit);
    if (anomalous.length && !options.includeAnomalies) anomaliesExcluded[market] = anomalous.length;
  });
  if (!(options.market in markets) && options.market !== "all") markets[options.market] = [];
  if (options.market === "all") for (const market of ["regular", "refurbish", "eilat"]) markets[market] ??= [];
  const values = Object.values(markets).flat().filter((value) => typeof value === "object");
  return { model_id: id, markets, returned: Object.fromEntries(Object.entries(markets).map(([key, items]) => [key, items.length])), anomalies_excluded: Object.keys(anomaliesExcluded).length ? anomaliesExcluded : undefined, note: values.length === 0 ? "No offers found for the selected market." : undefined, url: `${BASE_URL}/model.aspx?modelid=${id}` };
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
  const mergedSections = [...new Map(sections.map((section) => [section.section, { section: section.section, specs: sections.filter((item) => item.section === section.section).flatMap((item) => item.specs) }])).values()];
  return { model_id: id, sections: mergedSections, source_note: "Specifications are limited to fields Zap provides for this canonical model.", url: `${BASE_URL}/compmodels.aspx?modelid=${id}` };
}

export async function productHistory(model: string): Promise<unknown> {
  const id = await resolveModel(model);
  const payload = JSON.parse((await request("/modelpage/getpricechart", { params: { modelid: id, includepopularity: "true" } })).text);
  const chart = JSON.parse(payload.json ?? "{}");
  const points = (chart.rows ?? []).map((row: any) => prune({ date: row.c?.[0]?.v, price: row.c?.[1]?.v, popularity: row.c?.[2]?.f }));
  const prices = points.map((point: any) => point.price).filter((price: unknown): price is number => typeof price === "number");
  return { model_id: id, points, summary: prices.length ? { min: Math.min(...prices), max: Math.max(...prices), latest: prices.at(-1), change: prices.at(-1)! - prices[0] } : undefined, source_note: "Zap does not identify which merchant offer or bundle produced each historical point." };
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
  if (new Set(ids).size !== ids.length) throw new Error("compare requires distinct models");
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

export async function rawProductPage(model: string, resource: string, output?: string): Promise<unknown> {
  const id = await resolveModel(model);
  const paths: Record<string, string> = { model: "/model.aspx", specs: "/compmodels.aspx", reviews: "/ratemodel.aspx", "local-stores": "/modelofflinestores.aspx" };
  const response = await request(paths[resource], { params: { modelid: id } });
  const directory = join(tmpdir(), "zap-cli", id); await mkdir(directory, { recursive: true });
  const path = output ? resolve(output) : join(directory, `${resource}.html`); await mkdir(dirname(path), { recursive: true }); await writeFile(path, response.buffer);
  return { model_id: id, resource, path, url: response.url };
}
