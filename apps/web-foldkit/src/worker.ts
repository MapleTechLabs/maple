/**
 * The Foldkit dashboard on a PR preview, beside the React app at `app-pr-<n>`. It mirrors
 * apps/web's Worker (apps/web/src/worker.ts) and runs its entry, so `/_api` proxies the same way.
 */
import {
	ApiWorker,
	MapleStack,
	resolveRegionAppUrls,
	resolveWorkerName,
	resolveWorkerPlacement,
} from "@maple/infra/cloudflare"
import { plainFrom, selfObservabilityEnv } from "@maple/infra/env"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import { API_PROXY_PREFIX } from "../../web/src/api-proxy.ts"

const rootDir = new URL("..", import.meta.url).pathname

const props = Effect.gen(function* () {
	const { stage, region, urls } = yield* MapleStack
	const api = yield* ApiWorker
	const domain = stage.kind === "pr" ? `fk-pr-${stage.prNumber}.maple.dev` : undefined
	return {
		name: resolveWorkerName("web-foldkit", stage, region),
		rootDir,
		main: "src/worker-entry.ts",
		assets: {
			notFoundHandling: "single-page-application" as const,
			runWorkerFirst: [API_PROXY_PREFIX, `${API_PROXY_PREFIX}/*`],
		},
		// It also builds apps/web's entry and imports apps/web sources.
		memo: {
			include: [
				"**/*",
				"../web/src/**",
				"../web/public/**",
				"../../packages/*/src/**",
				"../../lib/*/src/**",
			],
			lockfile: true,
		},
		placement: resolveWorkerPlacement(region),
		workersDev: true,
		domain,
		env: {
			...(urls.api === "" ? undefined : { MAPLE_API_BASE_URL: urls.api }),
			API: api,
			...(yield* selfObservabilityEnv(stage, region)),
			VITE_API_BASE_URL:
				domain !== undefined && urls.api !== "" ? `https://${domain}${API_PROXY_PREFIX}` : urls.api,
			VITE_API_PUBLIC_URL: urls.api,
			VITE_INGEST_URL: urls.ingest,
			VITE_MAPLE_SELF_INGEST_URL:
				stage.kind === "pr"
					? yield* plainFrom(["VITE_INGEST_URL"], "https://ingest.maple.dev")
					: urls.ingest,
			VITE_ELECTRIC_SYNC_URL: urls.electricSync,
			VITE_MAPLE_REGION: region,
			VITE_MAPLE_REGION_APP_URLS: JSON.stringify(resolveRegionAppUrls(stage)),
			VITE_MAPLE_AUTH_MODE: yield* plainFrom(
				["VITE_MAPLE_AUTH_MODE", "MAPLE_AUTH_MODE"],
				"self_hosted",
			),
			VITE_CLERK_PUBLISHABLE_KEY: yield* plainFrom(
				["VITE_CLERK_PUBLISHABLE_KEY", "CLERK_PUBLISHABLE_KEY"],
				"",
			),
			VITE_MAPLE_INGEST_KEY: yield* plainFrom(
				["VITE_MAPLE_INGEST_KEY", "MAPLE_OTEL_PUBLIC_INGEST_KEY"],
				"",
			),
			VITE_COMMIT_SHA: yield* plainFrom(["VITE_COMMIT_SHA", "COMMIT_SHA", "GITHUB_SHA"], ""),
		},
	}
}).pipe(Effect.orDie)

// PR previews only (alchemy.run.ts). Logical id "app-foldkit" keys its state.
export default class WebFoldkit extends Cloudflare.Website.Vite<WebFoldkit>()("app-foldkit", props) {}
