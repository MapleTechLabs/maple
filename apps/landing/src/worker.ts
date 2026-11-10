/**
 * The marketing site: the Astro static build behind a small Worker
 * (`./worker-entry`) that negotiates markdown twins over the ASSETS binding.
 */
import {
	assetWorkerObservability,
	MapleStack,
	mapleSiteProps,
	WORKER_COMPATIBILITY_DATE,
	WorkersObservabilityDestinations,
} from "@maple/infra/cloudflare"
import { optionalPlain, optionalSecret, plainFrom } from "@maple/infra/env"
import { siteBuildMemo } from "@maple/infra/worker-build"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect } from "effect"

const props = Effect.gen(function* () {
	const stack = yield* MapleStack
	const { domains, urls } = stack
	const destinations = yield* WorkersObservabilityDestinations
	return {
		...mapleSiteProps("landing", stack),
		command: "bun run build",
		cwd: new URL("..", import.meta.url).pathname,
		outdir: "dist",
		main: new URL("./worker-entry.ts", import.meta.url).href,
		// Also the install scripts the build reads.
		memo: siteBuildMemo("../../scripts/install.sh", "../../scripts/uninstall.sh"),
		// Build inputs (folded into the memo hash); the Worker itself never reads them.
		env: {
			// Same ingest key as the web app, so marketing and product sessions share one org.
			PUBLIC_MAPLE_INGEST_KEY: yield* plainFrom(["MAPLE_OTEL_PUBLIC_INGEST_KEY"], ""),
			PUBLIC_INGEST_URL: urls.ingest,
			...(yield* optionalPlain("PUBLIC_CLERK_PUBLISHABLE_KEY")),
			...(yield* optionalPlain("PUBLIC_MAPLE_COOKIE_DOMAIN")),
			// Server-side build reads: the pricing table and the star count.
			...(yield* optionalSecret("AUTUMN_SECRET_KEY")),
			...(yield* optionalSecret("GITHUB_TOKEN")),
		},
		assets: {
			// Assets are served before the Worker runs, so extensionless pages (the ones with
			// a `.md` twin) must hit the Worker first for `Accept: text/markdown` to work.
			runWorkerFirst: ["/*", "!/_astro/*", "!/*.*"],
		},
		compatibility: { date: WORKER_COMPATIBILITY_DATE },
		observability: assetWorkerObservability(destinations),
		workersDev: true,
		domain: domains.landing,
	}
}).pipe(
	// StaticSite requires `never` errors; every config read here tolerates absence.
	Effect.orDie,
)

// Alchemy keys state by logical id: renaming `landing` replaces the Worker behind `maple.dev`.
export default class Landing extends Cloudflare.Website.StaticSite<Landing>()("landing", props) {}
