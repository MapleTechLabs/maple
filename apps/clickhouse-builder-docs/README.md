# Effect ClickHouse documentation

Fumapress site at https://effect-clickhouse.maple.dev, hosted as static assets on Cloudflare Workers.

Edit `lib/clickhouse-builder/docs/*.md`. Builds generate `content/` from those files,
add page metadata, and convert relative links to website routes. Generated content is ignored
by Git; existing package documentation checks continue to use the original files.

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd apps/clickhouse-builder-docs dev
bun run --cwd apps/clickhouse-builder-docs build
bun run --cwd apps/clickhouse-builder-docs typecheck
bun run --cwd apps/clickhouse-builder-docs deploy
```

Deployment requires Wrangler authentication for the Maki Account. `wrangler.jsonc` owns the
`effect-clickhouse-docs` Worker and its custom domain. This is an independent deployment;
the Maple Alchemy stack does not deploy it. Publish docs changes by running `deploy`.

The static build includes browser-side search, a sitemap, robots.txt, and llms.txt.
Waku is an explicit dependency so its build adapter resolves with Bun's isolated installs.
Social-image generation is omitted to avoid native image-rendering dependencies.
