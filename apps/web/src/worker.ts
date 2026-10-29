/**
 * The dashboard's Worker at `app.maple.dev` (and every region and stage), built by
 * `Cloudflare.Website.Vite`: one `vite build` for client and server. `VITE_*` env keys are
 * inlined into the client; other keys are Worker bindings.
 */
import {
	ApiWorker,
	MapleStack,
	resolveDeploymentEnvironment,
	resolveRegionAppUrls,
	resolveWorkerName,
	resolveWorkerPlacement,
} from "@maple/infra/cloudflare"
import { plainFrom, selfObservabilityEnv } from "@maple/infra/env"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect } from "effect"
import { API_PROXY_PREFIX } from "./api-proxy.ts"
import { WORKER_FIRST_PATHS } from "./worker-first.ts"

// `memo.include` also hashes the `@maple/*` sources; `lockfile` is restated because `include` drops it.
const MEMO_INCLUDE = ["**/*", "../../packages/*/src/**", "../../lib/*/src/**"]

const props = Effect.gen(function* () {
	const { stage, region, domains, urls } = yield* MapleStack
	const api = yield* ApiWorker
	return {
		name: resolveWorkerName("web", stage, region),
		rootDir: new URL("..", import.meta.url).pathname,
		main: "src/worker-entry.ts",
		assets: {
			// Deep links serve the shell in place; otherwise hard reloads 307 to "/".
			notFoundHandling: "single-page-application" as const,
			// Or the SPA fallback answers the API proxy and the image routes with the shell.
			runWorkerFirst: [...WORKER_FIRST_PATHS],
			// Vite's content-hashed output never changes under a name. Served by the asset layer,
			// not worker-first: the Worker is placed in one region, a hop that cost ~1s per cold load.
			headers: "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n",
		},
		memo: { include: MEMO_INCLUDE, lockfile: true },
		placement: resolveWorkerPlacement(region),
		workersDev: true,
		domain: domains.web,
		env: {
			// Share previews go over the service binding, which still needs an absolute URL.
			...(urls.api === "" ? undefined : { MAPLE_API_BASE_URL: urls.api }),
			API: api,
			...(yield* selfObservabilityEnv(stage, region)),
			// Client build inputs: a change here rebuilds with no source change.
			// Same-origin through the proxy where the stage has an app domain.
			VITE_API_BASE_URL:
				domains.web !== undefined && urls.api !== ""
					? `https://${domains.web}${API_PROXY_PREFIX}`
					: urls.api,
			VITE_API_PUBLIC_URL: urls.api,
			VITE_INGEST_URL: urls.ingest,
			// The app's own telemetry. A preview's gateway knows none of Maple's internal keys.
			VITE_MAPLE_SELF_INGEST_URL:
				stage.kind === "pr"
					? yield* plainFrom(["VITE_INGEST_URL"], "https://ingest.maple.dev")
					: urls.ingest,
			VITE_ELECTRIC_SYNC_URL: urls.electricSync,
			// The status Worker's origin, for the public page links; blank leaves them as paths.
			VITE_STATUS_PAGE_BASE_URL: yield* plainFrom(
				["VITE_STATUS_PAGE_BASE_URL", "MAPLE_STATUS_PAGE_BASE_URL"],
				"",
			),
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
			// Browser telemetry's `deployment.environment.name`, matching the Worker's (`pr-<n>` on previews).
			VITE_MAPLE_ENVIRONMENT: resolveDeploymentEnvironment(stage),
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
