# Local docker-compose build. Build context: repo root (workspace deps @maple/domain +
# @maple-dev/effect-sdk). Deploys use Dockerfile.prebuilt (apps/scraper/alchemy.run.ts).
FROM oven/bun:1.4.0 AS runner
WORKDIR /app

COPY . .
# Build the workspace SDK consumed by the scraper.
RUN bun install --frozen-lockfile \
	&& bun run --cwd packages/effect-sdk build

EXPOSE 3475

CMD ["bun", "run", "apps/scraper/src/main.ts"]
