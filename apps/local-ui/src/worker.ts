/**
 * The deployed local-mode dashboard (`local.maple.dev`) in alchemy's
 * single-module form: this file is both the resource the root stack yields
 * (`yield* LocalUi`) and the bundle alchemy deploys (`main: import.meta.url`).
 *
 * Deploying the SPA here decouples UI updates from `maple` binary releases:
 * the binary points users here by default and embeds this same `dist/` (via
 * rust-embed, see `apps/cli/src/server/ui-assets.ts`) only as the `--offline`
 * fallback. The SPA picks its `/local/query` base URL at runtime from
 * `window.location` (see `src/lib/constants.ts`). Static assets come off the
 * ASSETS binding; unknown routes fall back to the shell so the client router
 * can take over.
 */
import {
	assetWorkerObservability,
	MapleStack,
	resolveWorkerName,
	resolveWorkerPlacement,
	WorkersObservabilityDestinations,
} from "@maple/infra/cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"

interface AssetsBinding {
	readonly fetch: (request: Request) => Promise<Response>
}

/**
 * Alchemy evaluates a Worker's props wherever the class is yielded, the
 * deployed bundle included, where they are inert. `__ALCHEMY_RUNTIME__` folds to
 * `true` there, so the stack-side branch below, and the `@maple/infra` and
 * `alchemy/Command` modules only it reaches, are dead-code-eliminated.
 */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, region, domains } = yield* MapleStack
	const destinations = yield* WorkersObservabilityDestinations
	// A plain `vite build` to a flat `dist/`, the same tree the binary embeds.
	const build = yield* Command.Build("local-ui-build", {
		command: "bun run build",
		cwd: new URL("..", import.meta.url).pathname,
		outdir: "dist",
	})
	return {
		main: import.meta.url,
		name: resolveWorkerName("local-ui", stage, region),
		assets: { directory: build.outdir, hash: Output.map(build.hash, (h) => h.output ?? "") },
		placement: resolveWorkerPlacement(region),
		observability: assetWorkerObservability(destinations),
		workersDev: true,
		domain: domains.local,
	}
})

/**
 * This page can POST SQL to every visitor's loopback `maple start`, so an
 * injected script must not run. Vite emits only external module scripts; the
 * inline-style allowance covers the highlighted JSON views' `style` attributes.
 */
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self' data:",
	"connect-src 'self' http://127.0.0.1:* http://localhost:*",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ")

const SECURITY_HEADERS = {
	"content-security-policy": CONTENT_SECURITY_POLICY,
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "no-referrer",
	"cross-origin-opener-policy": "same-origin",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"strict-transport-security": "max-age=31536000",
} as const satisfies Readonly<Record<string, string>>

const withSecurityHeaders = (response: Response): Response => {
	// Asset responses can be immutable; copy before setting headers.
	const secured = new Response(response.body, response)
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value)
	return secured
}

const serve = async (request: Request, assets: AssetsBinding): Promise<Response> => {
	const asset = await assets.fetch(request)
	if (asset.status !== 404) return withSecurityHeaders(asset)
	return withSecurityHeaders(await assets.fetch(new Request(new URL("/index.html", request.url), request)))
}

export default class LocalUi extends Cloudflare.Worker<LocalUi>()(
	"local-ui",
	props,
	Effect.succeed({
		fetch: Effect.gen(function* () {
			const request = yield* Cloudflare.Workers.Request
			const env = yield* Cloudflare.WorkerEnvironment
			const assets: AssetsBinding = env.ASSETS
			return HttpServerResponse.fromWeb(yield* Effect.promise(() => serve(request, assets)))
		}),
	}),
) {}
