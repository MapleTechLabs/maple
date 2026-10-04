/**
 * The marketing site's Worker: the Astro static build in front of a small
 * Worker (`./worker-entry`) that does the markdown-twin negotiation over the
 * assets. `Cloudflare.Website.StaticSite` owns the build (memoized on the
 * sources below, skipped on destroy) and wires its output as the ASSETS
 * binding the handler reads. The root stack yields this class (`yield* Landing`).
 */
import {
	assetWorkerObservability,
	MapleStack,
	resolveWorkerName,
	resolveWorkerPlacement,
	WorkersObservabilityDestinations,
} from "@maple/infra/cloudflare"
import { optionalPlain, optionalSecret, plainWithDefault } from "@maple/infra/env"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"

const props = Effect.gen(function* () {
	const { stage, region, domains, urls } = yield* MapleStack
	const destinations = yield* WorkersObservabilityDestinations
	return {
		name: resolveWorkerName("landing", stage, region),
		command: "bun run build",
		cwd: new URL("..", import.meta.url).pathname,
		outdir: "dist",
		main: new URL("./worker-entry.ts", import.meta.url).href,
		// The default scope hashes only this app's tree and the lockfile; the build
		// also compiles the `@maple/*` packages and copies the CLI install scripts.
		// `lockfile` is restated because providing `include` drops it.
		memo: {
			include: [
				"**/*",
				"../../packages/*/src/**",
				"../../lib/*/src/**",
				"../../scripts/install.sh",
				"../../scripts/uninstall.sh",
			],
			lockfile: true,
		},
		// Everything the Astro build reads, so a change produces a new bundle: the
		// memo hash folds in this env. StaticSite also binds each entry on the
		// Worker, which never reads them (the secrets land as secret bindings).
		env: {
			// Inlined at build time. Same ingest key the web app uses, so a visitor's
			// marketing and product sessions land side by side in one org.
			PUBLIC_MAPLE_INGEST_KEY: (yield* plainWithDefault("MAPLE_OTEL_PUBLIC_INGEST_KEY", ""))
				.MAPLE_OTEL_PUBLIC_INGEST_KEY,
			PUBLIC_INGEST_URL: urls.ingest,
			...(yield* optionalPlain("PUBLIC_CLERK_PUBLISHABLE_KEY")),
			...(yield* optionalPlain("PUBLIC_MAPLE_COOKIE_DOMAIN")),
			// Server-side build reads: the pricing table and the star count.
			...(yield* optionalSecret("AUTUMN_SECRET_KEY")),
			...(yield* optionalSecret("GITHUB_TOKEN")),
		},
		assets: {
			// Workers Assets serves a matching file *before* invoking the Worker,
			// so without this the handler never sees a request for a real page
			// and the `Accept: text/markdown` negotiation is dead code. Scoped to
			// extensionless paths, the ones with a `.md` twin. Anything with a dot
			// (hashed `/_astro/*`, images, the `.md` and `.txt` files themselves)
			// still comes straight off the asset layer with no Worker invocation.
			runWorkerFirst: ["/*", "!/_astro/*", "!/*.*"],
		},
		compatibility: { date: "2026-10-01" },
		placement: resolveWorkerPlacement(region),
		observability: assetWorkerObservability(destinations),
		workersDev: true,
		domain: domains.landing,
	}
}).pipe(
	// StaticSite takes props whose error channel is `never`. The only failures
	// are `ConfigError`s from reads that all tolerate absence, so reaching the
	// error channel means the stack cannot read its own configuration.
	Effect.orDie,
)

// The logical id stays `landing`: a rename would plan a delete + create of the
// Worker behind `maple.dev`.
export default class Landing extends Cloudflare.Website.StaticSite<Landing>()("landing", props) {}
