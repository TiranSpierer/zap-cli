# zap-cli

CLI for searching and reading [Zap](https://www.zap.co.il), Israel's price-comparison service. Search products, compare store offers and delivered prices, read specifications and reviews, inspect price history, compare models, browse filters, and inspect stores.

## Install

Recommended: install [`israel-shopping`](https://github.com/TiranSpierer/agent-plugins) from the agent plugin marketplace.

```bash
npx -y git+https://github.com/TiranSpierer/zap-cli.git zap-cli --help
```

---

<details>
<summary>Product commands</summary>

```bash
zap-cli product search "iphone 17"
zap-cli product search "oled" --category e-tv --sort price
zap-cli product search --category e-tv --filter 189989=190050 --filter 4004=8568084
zap-cli product metadata <model-id-or-url>
zap-cli product offers <model-id-or-url> --market regular --sort price
zap-cli product specs <model-id-or-url>
zap-cli product reviews <model-id-or-url> --page 1
zap-cli product history <model-id-or-url>
zap-cli product similar <model-id-or-url>
zap-cli product images <model-id-or-url>
zap-cli product local-stores <model-id-or-url>
zap-cli product compare <model-id> <model-id>
```

Organic models are returned by default. Use `--include-promoted` to inspect paid placements separately. Offer output keeps regular and Eilat offers separate; delivered price includes known shipping for regular delivery offers.

</details>

<details>
<summary>Category and store commands</summary>

```bash
zap-cli category list
zap-cli category filters e-tv
zap-cli store metadata <site-id-or-url>
zap-cli store reviews <site-id-or-url> --page 2
zap-cli suggest "iphone 17"
```

</details>

<details>
<summary>Output and requirements</summary>

Commands print compact YAML. Image downloads go under `<os-temp>/zap-cli/<model-id>/`.

- Node.js 20+
- No account or API key

Zap has no public product API. The CLI reads its server-rendered pages and narrowly scoped frontend endpoints.

</details>

<details>
<summary>Local development</summary>

```bash
npm install
npm test
node dist/index.js --help
```

</details>
