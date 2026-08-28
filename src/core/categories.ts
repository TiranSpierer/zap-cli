import { load } from "cheerio";
import { request } from "./client.js";
import { BASE_URL, clean, numeric, prune } from "./common.js";

const MAINS = ["electric", "comp", "bait", "sport", "health", "20"];

function distance(a: string, b: string): number {
  const row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = saved;
    }
  }
  return row[b.length];
}

function matches(query: string, value: string): boolean {
  const needle = query.toLowerCase(); const haystack = value.toLowerCase();
  if (haystack.includes(needle)) return true;
  const tokens = needle.split(/\s+/).filter((token) => token.length > 1);
  const tokenMatches = (token: string) => {
    if (haystack.includes(token) || haystack.includes(`ו${token}`)) return true;
    for (let length = Math.max(1, token.length - 1); length <= token.length + 1; length++) for (let index = 0; index + length <= haystack.length; index++) if (distance(token, haystack.slice(index, index + length)) <= 1) return true;
    return false;
  };
  if (tokens.length > 1 && tokens.every(tokenMatches)) return true;
  if (needle.length < 4) return false;
  for (let length = Math.max(1, needle.length - 1); length <= needle.length + 1; length++) {
    for (let index = 0; index + length <= haystack.length; index++) if (distance(needle, haystack.slice(index, index + length)) <= 1) return true;
  }
  return false;
}

export async function listCategories(query = ""): Promise<unknown> {
  const groups: unknown[] = []; const seen = new Set<string>();
  for (const main of MAINS) {
    const $ = load((await request("/header/getsubmenuhtml", { params: { catname: main } })).text);
    $(".cats-links").each((_, element) => {
      const family = $(element); const familyId = family.attr("data-catid"); const categories: unknown[] = [];
      family.find('a[href*="models.aspx?sog="]').each((_, linkElement) => {
        const link = $(linkElement); const href = link.attr("href"); const code = href ? new URL(href, BASE_URL).searchParams.get("sog") : null;
        if (!code || seen.has(code)) return;
        if (query && !matches(query, `${code} ${clean(link.text())}`)) return;
        seen.add(code);
        categories.push({ code, name: clean(link.text()), url: `${BASE_URL}/models.aspx?sog=${code}` });
      });
      if (categories.length) groups.push({ main, family: clean($(`[data-catid="${familyId}"]`).first().text()), categories });
    });
  }
  return { count: seen.size, groups };
}

function options($: ReturnType<typeof load>): unknown[] {
  const result: unknown[] = []; const seen = new Set<string>();
  $(".filter-row[id]").each((_, element) => {
    const row = $(element); const id = row.attr("id"); const name = clean(row.attr("aria-label") ?? row.find(".filter-txt").first().text());
    if (id && name && !seen.has(id)) { seen.add(id); result.push(prune({ id, name, count: numeric(row.attr("data-count")) })); }
  });
  return result;
}

export async function categoryFilters(category: string, query: string | undefined, allOptions: boolean): Promise<unknown> {
  const response = await request("/models.aspx", { params: { sog: category, keyword: query } }); const $ = load(response.text); const groups: unknown[] = [];
  for (const element of $(".filter-column").toArray()) {
    const column = $(element); const nameNode = column.find("[data-dbid]").first(); const id = nameNode.attr("data-dbid");
    if (!id) continue; let values = options(load(column.html() ?? ""));
    if (allOptions && !query) {
      const expanded = load((await request("/models/getmorefiltersbyorder", { params: { dbid: id, keyword: query ?? "", orderby: "abc", sogname: category, link: `${BASE_URL}/models.aspx?sog=${category}` } })).text);
      values = options(expanded).length ? options(expanded) : values;
    }
    if (values.length) groups.push({ id, name: clean(nameNode.text()), options: values });
  }
  return prune({ category, query, filter_groups: groups });
}
