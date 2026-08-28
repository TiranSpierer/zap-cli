#!/usr/bin/env node
import { Command, Option } from "commander";
import { categoryFilters, listCategories } from "./core/categories.js";
import { compareProducts, localStores, productHistory, productImages, productMetadata, productOffers, productSpecs, rawProductPage, searchProducts, similarProducts } from "./core/products.js";
import { productReviews } from "./core/reviews.js";
import { searchStores, storeMetadata, storeReviews } from "./core/stores.js";
import { suggestions } from "./core/suggestions.js";
import { toYaml } from "./format.js";

const program = new Command().name("zap-cli").description("CLI for searching and reading Zap Israel").version("0.2.0").showHelpAfterError();
const output = async (work: Promise<unknown>): Promise<void> => { process.stdout.write(`${toYaml(await work)}\n`); };
const positive = (value: string): number => { const result = Number(value); if (!Number.isInteger(result) || result < 1) throw new Error("value must be a positive integer"); return result; };

const product = program.command("product").description("Product operations");
product.command("search [query]").description("Search Zap products")
  .option("--category <code>", "Zap category code, such as e-tv")
  .option("--page <number>", "Zap result page; --limit truncates that page", positive, 1)
  .addOption(new Option("--sort <order>", "result order").choices(["popular", "new", "price", "price-desc", "rating", "reviews"]).default("popular"))
  .option("--limit <number>", "maximum models and store offers per result type", positive, 24)
  .option("--filter <selection>", "facet selection GROUP=OPTION[,OPTION]; repeatable", (value, previous: string[]) => previous.concat(value), [])
  .option("--all-pages", "fetch subsequent pages up to --limit")
  .option("--include-sponsored", "include sponsored bid placements")
  .action((query = "", options) => output(searchProducts({ query, category: options.category, page: options.page, sort: options.sort, limit: options.limit, filters: options.filter, allPages: Boolean(options.allPages), includeSponsored: Boolean(options.includeSponsored) })));

for (const [name, description, handler] of [
  ["metadata", "Get product metadata", productMetadata], ["specs", "Get full product specifications", productSpecs],
  ["history", "Get product price history", productHistory], ["images", "Download product images", productImages],
  ["local-stores", "List local-store offers", localStores],
] as const) product.command(`${name} <model>`).description(description).action((model) => output(handler(model)));

product.command("offers <model>").description("List store offers for a product")
  .addOption(new Option("--market <market>", "offer market").choices(["all", "regular", "eilat", "refurbish"]).default("all"))
  .addOption(new Option("--sort <order>", "offer order").choices(["recommendation", "price"]).default("recommendation"))
  .option("--limit <number>", "maximum offers per market", positive, 20)
  .option("--details", "include full merchant descriptions")
  .action((model, options) => output(productOffers(model, options)));
product.command("reviews <model>").description("Read product reviews").option("--page <number>", "review page", positive, 1)
  .option("--limit <number>", "maximum reviews", positive, 10)
  .addOption(new Option("--sort <order>", "review order").choices(["date", "rating", "rating-asc"]).default("date"))
  .action((model, options) => output(productReviews(model, options.page, options.sort, options.limit)));
product.command("similar <model>").description("List similar products").option("--limit <number>", "maximum results", positive, 20).action((model, options) => output(similarProducts(model, options.limit)));
product.command("compare <models...>").description("Compare two to four products").action((models) => output(compareProducts(models)));
product.command("raw <model>").description("Save an unmodified Zap HTML page for unsupported fields")
  .addOption(new Option("--resource <page>", "page to save").choices(["model", "specs", "reviews", "local-stores"]).default("model"))
  .action((model, options) => output(rawProductPage(model, options.resource)));

const category = program.command("category").description("Category operations");
category.command("list [query]").description("List Zap product categories").action((query = "") => output(listCategories(query)));
category.command("filters <category>").description("List filters for a category").option("--query <query>", "restrict facets to a query").option("--all-options", "expand every option in each filter group").action((code, options) => output(categoryFilters(code, options.query, Boolean(options.allOptions))));

const store = program.command("store").description("Store operations");
store.command("search <query>").description("Search Zap stores by name").option("--limit <number>", "maximum stores", positive, 10).action((query, options) => output(searchStores(query, options.limit)));
store.command("metadata <store>").description("Get Zap store metadata").action((id) => output(storeMetadata(id)));
store.command("reviews <store>").description("Read Zap store reviews").option("--page <number>", "review page", positive, 1).option("--limit <number>", "maximum reviews", positive, 10).action((id, options) => output(storeReviews(id, options.page, options.limit)));

program.command("suggest <query>").description("Get Zap search suggestions").option("--limit <number>", "maximum suggestions", positive, 20).action((query, options) => output(suggestions(query, options.limit)));

program.parseAsync(process.argv).catch((error) => { process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
