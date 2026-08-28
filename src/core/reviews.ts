import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { request } from "./client.js";
import { BASE_URL, clean, extractId, numeric, prune } from "./common.js";

function review($: CheerioAPI, node: Cheerio<AnyNode>): unknown {
  const style = node.find(".RateStars span").first().attr("style"); const width = style?.match(/width:\s*(\d+)/)?.[1];
  const opinions = node.find(".opinion .text").map((_, element) => clean($(element).text())).get().filter(Boolean);
  return prune({
    review_id: node.find("[data-reviewid]").first().attr("data-reviewid"), title: clean(node.find(".ReviewTitle").first().text()),
    body: clean(node.find(".ReviewTxt").first().text()), pros: opinions[0], cons: opinions.length > 1 ? opinions.at(-1) : undefined,
    author: clean(node.find(".WriterName").first().text()), date: clean(node.find(".ReviewDate").first().text()), score: width ? Number(width) / 18 : undefined,
  });
}

export async function productReviews(model: string, page: number, sort: string): Promise<unknown> {
  const id = extractId(model, "modelid"); const orderby: Record<string, string> = { date: "insertiondatedesc", rating: "userscoredesc", "rating-asc": "userscoreasc" };
  const $ = load((await request("/ratemodel.aspx", { params: { modelid: id, pageinfo: page, orderby: orderby[sort] } })).text);
  const reviews = $(".reviewBody").map((_, element) => review($, $(element))).get();
  return { model_id: id, total: numeric($(".count-store").first().text()) ?? reviews.length, page, reviews, url: `${BASE_URL}/ratemodel.aspx?modelid=${id}` };
}

