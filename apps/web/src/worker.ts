/**
 * The dashboard's Worker, built by `Cloudflare.Website.Vite` (one `vite build`
 * for client and server). `bun dev` serves it through alchemy's vite child, which
 * strips the CLI's `NODE_ENV=production` so `import.meta.env.DEV` is correct.
 * `VITE_*` env keys are inlined into the client; other keys are Worker bindings.
 */
import {
	ApiWorker,
	MapleStack,
	resolveRegionAppUrls,
	resolveWorkerName,
	resolveWorkerPlacement,
} from "@maple/infra/cloudflare"
import { plainFrom } from "@maple/infra/env"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"

const rootDir = new URL("..", import.meta.url).pathname

const props = Effect.gen(function* () {
	const { stage, region, domains, urls } = yield* MapleStack
	const api = yield* ApiWorker
	return {
		name: resolveWorkerName("web", stage, region),
		rootDir,
		main: "src/worker-entry.ts",
		assets: {
			// Deep links serve the shell in place; otherwise hard reloads 307 to "/".
			notFoundHandling: "single-page-application" as const,
		},
		// Also hash the `@maple/*` sources; `lockfile` is restated because `include` drops it.
		memo: {
			include: ["**/*", "../../packages/*/src/**", "../../lib/*/src/**"],
			lockfile: true,
		},
		placement: resolveWorkerPlacement(region),
		workersDev: true,
		domain: domains.web,
		env: {
			// Share previews go over the service binding, which still needs an absolute URL.
			...(urls.api === "" ? undefined : { MAPLE_API_BASE_URL: urls.api }),
			API: api,
			// Client build inputs: a change here rebuilds with no source change.
			VITE_API_BASE_URL: urls.api,
			VITE_INGEST_URL: urls.ingest,
			VITE_ELECTRIC_SYNC_URL: urls.electricSync,
			// Orgs living in another region are redirected to that region's app.
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
			// Stamped onto browser telemetry as `vcs.ref.head.revision` / `service.version`.
			VITE_COMMIT_SHA: yield* plainFrom(["VITE_COMMIT_SHA", "COMMIT_SHA", "GITHUB_SHA"], ""),
		},
	}
}).pipe(
	// `Website.Vite` requires `never` errors; every `plainFrom` here has a default.
	Effect.orDie,
)

// Alchemy keys state by logical id: renaming `app` replaces the Worker behind `app.maple.dev`.
export default class Web extends Cloudflare.Website.Vite<Web>()("app", props) {}
