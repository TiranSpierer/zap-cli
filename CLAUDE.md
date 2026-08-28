# CLAUDE.md

TypeScript CLI for searching and reading Zap Israel.

## Commands

```bash
npm install
npm test
npm run build
node dist/index.js --help
```

## Architecture

- `core/` contains framework-neutral Zap operations and HTML parsers.
- `core/client.ts` is the single HTTP boundary, including cookies, redirects, and legacy charset decoding.
- `index.ts` defines the resource-oriented command hierarchy and calls the core.
- `format.ts` serializes terminal output as compact YAML.
- Product images are written under the OS temporary directory.

## Changes

- Keep CLI parsing and rendering out of core modules.
- Route every Zap request through `core/client.ts`.
- Keep promoted placements separate from organic results.
- Preserve ambiguous Zap fields as raw values instead of inventing semantics.
- Update README for user-visible behavior changes.
- Run tests and representative live commands before committing.

