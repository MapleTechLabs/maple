/**
 * The local-mode dashboard (`local.maple.dev`) behind a small Worker
 * (`./worker-entry`) adding security headers and the SPA fallback. The `maple`
 * binary embeds this same `dist/` as its `--offline` fallback.
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
		command: "bun run build",
		cwd: new URL("..", import.meta.url).pathname,
		outdir: "dist",
		main: new URL("./worker-entry.ts", import.meta.url).href,
		// Also hash the `@maple/*` sources; `lockfile` is restated because `include` drops it.
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
	// StaticSite requires `never` errors; a failure here is unreadable stack config.
	Effect.orDie,
)

// Alchemy keys state by logical id: renaming `local-ui` replaces the Worker behind `local.maple.dev`.
export default class LocalUi extends Cloudflare.Website.StaticSite<LocalUi>()("local-ui", props) {}
