import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { request } from "./client.js";
import { BASE_URL, clean, numeric, prune } from "./common.js";
import { resolveModel } from "./products.js";

function review($: CheerioAPI, node: Cheerio<AnyNode>, structured: any): unknown {
  const opinions: Record<string, string> = {};
  node.find(".opinion").each((_, element) => {
    const item = $(element); const label = item.find("img").attr("alt"); const value = clean(item.find(".text").text());
    if (label && value) opinions[label] = value;
  });
  return prune({
    review_id: node.find("[data-reviewid]").first().attr("data-reviewid"), title: clean(node.find(".ReviewTitle").first().text()),
    body: clean(structured?.reviewBody ?? node.find(".ReviewTxt").first().text()), pros: opinions["יתרונות"], neutral: opinions["ניטראלי"], cons: opinions["חסרונות"],
    author: clean(structured?.author?.name ?? structured?.author ?? node.find(".WriterName").first().text()), date: structured?.datePublished ?? clean(node.find(".ReviewDate").first().text()),
    score: numeric(structured?.reviewRating?.ratingValue),
  });
}

function structuredReviews($: CheerioAPI): any[] {
  const found: any[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try { const data = JSON.parse($(element).text()); const values = Array.isArray(data?.review) ? data.review : data?.review ? [data.review] : []; found.push(...values); } catch { /* invalid third-party JSON-LD */ }
  });
  return found;
}

export async function productReviews(model: string, page: number, sort: string, limit: number): Promise<unknown> {
  const id = await resolveModel(model); const orderby: Record<string, string> = { date: "insertiondatedesc", rating: "userscoredesc", "rating-asc": "userscoreasc" };
  const $ = load((await request("/ratemodel.aspx", { params: { modelid: id, pageinfo: page, orderby: orderby[sort] } })).text);
  const structured = structuredReviews($);
  const reviews = $(".reviewBody").slice(0, limit).map((index, element) => review($, $(element), structured[index])).get();
  const heading = clean($("#reviewsPage .count-line-review .count-store").first().text());
  const countMatch = heading.match(/נמצאו?\s+(\d+)\s+חוות/);
  const total = /חוות דעת אחת/.test(heading) ? 1 : countMatch ? Number(countMatch[1]) : reviews.length;
  return { model_id: id, total: reviews.length ? total : 0, returned: reviews.length, page, reviews, note: !reviews.length ? "No product reviews found." : total > reviews.length ? "More reviews exist; request the next page to continue." : undefined, url: `${BASE_URL}/ratemodel.aspx?modelid=${id}` };
}
