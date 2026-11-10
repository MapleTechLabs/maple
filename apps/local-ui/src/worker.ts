/**
 * The local-mode dashboard (`local.maple.dev`) behind a small Worker
 * (`./worker-entry`) adding security headers and the SPA fallback. The `maple`
 * binary embeds this same `dist/` as its `--offline` fallback.
 */
import {
	assetWorkerObservability,
	MapleStack,
	mapleSiteProps,
	WorkersObservabilityDestinations,
} from "@maple/infra/cloudflare"
import { siteBuildMemo } from "@maple/infra/worker-build"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect } from "effect"

const props = Effect.gen(function* () {
	const stack = yield* MapleStack
	const destinations = yield* WorkersObservabilityDestinations
	return {
		...mapleSiteProps("local-ui", stack),
		command: "bun run build",
		cwd: new URL("..", import.meta.url).pathname,
		outdir: "dist",
		main: new URL("./worker-entry.ts", import.meta.url).href,
		memo: siteBuildMemo(),
		observability: assetWorkerObservability(destinations),
		workersDev: true,
		domain: stack.domains.local,
	}
}).pipe(
	// StaticSite requires `never` errors; a failure here is unreadable stack config.
	Effect.orDie,
)

// Alchemy keys state by logical id: renaming `local-ui` replaces the Worker behind `local.maple.dev`.
export default class LocalUi extends Cloudflare.Website.StaticSite<LocalUi>()("local-ui", props) {}
