# The repository sandbox's container. Sandbox SDK 1.0 ships only its helper binary, so the
# toolset the agent tools promise (git, coreutils, awk, sed, jq, node, bun) is built here.
# Every tag is pinned: `alchemy.run.ts` rebuilds on a content change, and `verify:image` runs this.
FROM docker.io/cloudflare/sandbox:1.0.0 AS sandbox
FROM docker.io/oven/bun:1.4.0-slim AS bun

FROM docker.io/library/node:24-trixie-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git jq \
	&& rm -rf /var/lib/apt/lists/*
# `Files` and `DirectoryBackup` run this helper; its tag must match `@cloudflare/sandbox`.
COPY --from=sandbox /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# A restore needs the target's parent to exist, and the seed lands under it.
RUN mkdir -p /workspace
# The Durable Object runs everything through `exec()`; the container only has to stay up.
CMD ["sleep", "infinity"]
