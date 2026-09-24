# Effect ClickHouse documentation

Fumapress site at https://effect-clickhouse.maple.dev, hosted as static assets on Cloudflare Workers.

Edit `docs/*.md` in [effect-clickhouse](https://github.com/MapleTechLabs/effect-clickhouse),
release the package, then update this app’s pinned dependency. Builds generate `content/`
from the installed package’s docs,
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

For documentation-only corrections, run the library’s documentation checks, then
build or deploy with an explicit local source directory:

```sh
EFFECT_CLICKHOUSE_DOCS_DIR=/absolute/path/to/effect-clickhouse/docs \
bun run --cwd apps/clickhouse-builder-docs deploy
```

Without this override, builds use the pinned package’s documentation. Keep using the
override for subsequent deployments until a new package release includes the corrections.
