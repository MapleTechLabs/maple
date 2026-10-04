/**
 * The deployed local-mode dashboard (`local.maple.dev`): a plain `vite build`
 * to a flat `dist/` behind a small Worker (`./worker-entry`) that adds the
 * security headers and the SPA fallback. `Cloudflare.Website.StaticSite` owns
 * the build and wires its output as the ASSETS binding. The root stack yields
 * this class (`yield* LocalUi`).
 *
 * Deploying the SPA here decouples UI updates from `maple` binary releases:
 * the binary points users here by default and embeds this same `dist/` (via
 * rust-embed, see `apps/cli/src/server/ui-assets.ts`) only as the `--offline`
 * fallback. The SPA picks its `/local/query` base URL at runtime from
 * `window.location` (see `src/lib/constants.ts`).
 */
import {
	assetWorkerObservability,
	MapleStack,
	resolveWorkerName,
	resolveWorkerPlacement,
	WorkersObservabilityDestinations,
} from "@maple/infra/cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"

const props = Effect.gen(function* () {
	const { stage, region, domains } = yield* MapleStack
	const destinations = yield* WorkersObservabilityDestinations
	return {
		name: resolveWorkerName("local-ui", stage, region),
		// A plain `vite build` to a flat `dist/`, the same tree the binary embeds.
		command: "bun run build",
		cwd: new URL("..", import.meta.url).pathname,
		outdir: "dist",
		main: new URL("./worker-entry.ts", import.meta.url).href,
		// The default scope hashes only this app's tree and the lockfile, not the
		// `@maple/*` packages the bundle compiles in. `lockfile` is restated
		// because providing `include` drops it.
		memo: {
			include: ["**/*", "../../packages/*/src/**", "../../lib/*/src/**"],
			lockfile: true,
		},
		placement: resolveWorkerPlacement(region),
		observability: assetWorkerObservability(destinations),
		workersDev: true,
		domain: domains.local,
	}
}).pipe(
	// StaticSite takes props whose error channel is `never`; the only failure is a
	// `ConfigError` reading the observability destinations, a stack that cannot
	// read its own configuration.
	Effect.orDie,
)

// The logical id stays `local-ui`: a rename would plan a delete + create of the
// Worker behind `local.maple.dev`.
export default class LocalUi extends Cloudflare.Website.StaticSite<LocalUi>()("local-ui", props) {}
