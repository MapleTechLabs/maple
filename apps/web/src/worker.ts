/**
 * The dashboard's Worker, deployed from its own Vite project.
 *
 * `Cloudflare.Website.Vite` owns the build: one `vite build` through the
 * Cloudflare Vite plugin produces the client assets and the server bundle, and
 * alchemy uploads both. It replaced a `Command.Build` that shelled out to
 * `bun run build` and an `assets` block pointed at its `dist/`.
 *
 * The reason for the move is dev, not deploy. A vite source is served by
 * alchemy's own vite child, so `bun dev` runs this Worker in workerd against a
 * real vite dev server instead of spawning a bare `vite dev` beside the stack.
 * That bare spawn inherited the alchemy CLI's `NODE_ENV=production`, which Vite
 * reads for `import.meta.env.DEV`/`PROD` rather than taking from `--mode`, so
 * the dev server served `MODE: "development"` next to `DEV: false, PROD: true`.
 * Every dev-only branch was dead and every production branch live; `/lab` 404ing
 * through `bun dev` was the visible half. Alchemy's vite child strips the
 * variable and says why (`Cloudflare/Workers/ViteChild.ts`); it simply never ran
 * for us, because we were not using a vite source.
 *
 * `VITE_*` keys in `env` are inlined into the client bundle as
 * `import.meta.env.*` by the vite source, which is the same job the removed
 * `Command.Build`'s env did through `vite.config.ts`'s `define`. Non-prefixed
 * keys stay ordinary Worker bindings.
 */
import {
	ApiWorker,
	CLOUDFLARE_WORKER_PLACEMENT,
	MapleStack,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import { plainFrom } from "@maple/infra/env"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"

/** This app's own root, which is where its `vite.config.ts` lives. */
const rootDir = new URL("..", import.meta.url).pathname

const props = Effect.gen(function* () {
	const { stage, domains, urls } = yield* MapleStack
	const api = yield* ApiWorker
	return {
		name: resolveWorkerName("web", stage),
		rootDir,
		// The deployed entry. A vite source owns the Worker entry, so the Effect
		// implementation this class used to take as a third argument moved into
		// this module; it was only unwrapping a request and three bindings.
		main: "src/worker-entry.ts",
		assets: {
			// Deep links must serve the shell at the requested URL: without this the
			// binding 404s, the handler fetches /index.html, and the assets layer's
			// trailing-slash normalization 307s that to "/" on every hard reload.
			notFoundHandling: "single-page-application" as const,
		},
		// The default memo scope hashes this app's own tree and the lockfile, which
		// would not notice an edit to the `@maple/*` packages the bundle compiles
		// in. `lockfile` is restated because providing `include` drops it.
		memo: {
			include: ["**/*", "../../packages/*/src/**", "../../lib/*/src/**"],
			lockfile: true,
		},
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		workersDev: true,
		domain: domains.web,
		env: {
			// Bindings. The share-preview lookups ride the service binding; the URL is
			// still bound because bindings address requests by absolute URL. A dev
			// stage without an api domain binds neither and previews degrade to the
			// generic card.
			...(urls.api === "" ? undefined : { MAPLE_API_BASE_URL: urls.api }),
			API: api,
			// Inlined into the client bundle as `import.meta.env.*`. These were the
			// removed `Command.Build`'s env, and they remain build inputs: a stage's
			// URLs or the commit changing rebuilds with no source change.
			VITE_API_BASE_URL: urls.api,
			VITE_INGEST_URL: urls.ingest,
			VITE_ELECTRIC_SYNC_URL: urls.electricSync,
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
	// `Website.Vite` takes props whose error channel is `never`, where
	// `Cloudflare.Worker` tolerated one. The only failure in here is a
	// `ConfigError` from `plainFrom`, and every one of those calls carries a
	// default, so reaching the error channel at all means the stack cannot read
	// its own configuration. There is nothing for a caller to do with that.
	Effect.orDie,
)

// The logical id stays `app`: it names the deployed resource, and a rename would
// plan a delete + create of the Worker behind `app.maple.dev`.
export default class Web extends Cloudflare.Website.Vite<Web>()("app", props) {}
