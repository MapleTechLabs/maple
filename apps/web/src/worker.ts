/**
 * The dashboard's Worker in alchemy's single-module form: this file is both
 * the resource the root stack yields (`yield* Web`) and the bundle alchemy
 * deploys (`main: import.meta.url`). The Vite build is yielded from the props,
 * and every request goes to `./handler` — OG images, the share preview, the
 * SPA shell fallback — which stays a plain function so its tests need no
 * Worker runtime.
 */
import { ApiWorker, CLOUDFLARE_WORKER_PLACEMENT, MapleStack, resolveWorkerName } from "@maple/infra/cloudflare"
import { plainFrom } from "@maple/infra/env"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { handleRequest } from "./handler"

/**
 * Alchemy evaluates a Worker's props wherever the class is yielded — the
 * deployed bundle included, where they are inert. `__ALCHEMY_RUNTIME__` folds to
 * `true` there, so the stack-side branch below, and the `@maple/infra` and
 * `alchemy/Command` modules only it reaches, are dead-code-eliminated.
 */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, domains, urls } = yield* MapleStack
	const api = yield* ApiWorker
	// The build runs through `Command.Build` so the VITE_* env is part of the
	// memo hash: a stage's URLs (or the commit) changing re-runs it with no
	// source change. vite.config.ts turns these into `define` overrides.
	const build = yield* Command.Build("web-build", {
		command: "bun run build",
		cwd: new URL("..", import.meta.url).pathname,
		outdir: "dist",
		env: {
			VITE_API_BASE_URL: urls.api,
			VITE_INGEST_URL: urls.ingest,
			VITE_ELECTRIC_SYNC_URL: urls.electricSync,
			VITE_MAPLE_AUTH_MODE: yield* plainFrom(["VITE_MAPLE_AUTH_MODE", "MAPLE_AUTH_MODE"], "self_hosted"),
			VITE_CLERK_PUBLISHABLE_KEY: yield* plainFrom(["VITE_CLERK_PUBLISHABLE_KEY", "CLERK_PUBLISHABLE_KEY"], ""),
			VITE_MAPLE_INGEST_KEY: yield* plainFrom(["VITE_MAPLE_INGEST_KEY", "MAPLE_OTEL_PUBLIC_INGEST_KEY"], ""),
			// Stamped onto browser telemetry as `vcs.ref.head.revision` / `service.version`.
			VITE_COMMIT_SHA: yield* plainFrom(["VITE_COMMIT_SHA", "COMMIT_SHA", "GITHUB_SHA"], ""),
		},
	})
	return {
		main: import.meta.url,
		name: resolveWorkerName("web", stage),
		assets: {
			directory: build.outdir,
			hash: Output.map(build.hash, (h) => h.output ?? ""),
			// Deep links must serve the shell at the requested URL: without this the
			// binding 404s, the handler fetches /index.html, and the assets layer's
			// trailing-slash normalization 307s that to "/" on every hard reload.
			notFoundHandling: "single-page-application" as const,
		},
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		workersDev: true,
		domain: domains.web,
		// The share-preview lookups ride the service binding; the URL is still
		// bound because bindings address requests by absolute URL. A dev stage
		// without an api domain binds neither and previews degrade to the generic card.
		env: {
			...(urls.api === "" ? undefined : { MAPLE_API_BASE_URL: urls.api }),
			API: api,
		},
	}
})

// The logical id stays `app`: it names the deployed resource, and a rename would
// plan a delete + create of the Worker behind `app.maple.dev`.
export default class Web extends Cloudflare.Worker<Web>()(
	"app",
	props,
	Effect.succeed({
		fetch: Effect.gen(function* () {
			const request = yield* Cloudflare.Workers.Request
			const env = yield* Cloudflare.WorkerEnvironment
			return HttpServerResponse.fromWeb(
				yield* Effect.promise(() =>
					handleRequest(request, {
						ASSETS: env.ASSETS,
						API: env.API,
						MAPLE_API_BASE_URL: env.MAPLE_API_BASE_URL,
					}),
				),
			)
		}),
	}),
) {}
