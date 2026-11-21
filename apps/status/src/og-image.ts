/**
 * `StatusEnv.ogImage` in the Worker: the colo cache first, else load the logo and draw. Each card
 * version renders once per colo; the version is in the cache key, so a status change misses.
 */
import init from "@takumi-rs/wasm"
import wasmModule from "@takumi-rs/wasm/auto"
import type { StatusOgCard } from "@maple/status-page"
import { Duration, Effect, String as Str } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import monoCyrillic from "./og-fonts/mono-cyrillic.ttf"
import monoLatinExt from "./og-fonts/mono-latin-ext.ttf"
import monoLatin from "./og-fonts/mono-latin.ttf"
import sansCyrillic from "./og-fonts/sans-cyrillic.ttf"
import sansLatinExt from "./og-fonts/sans-latin-ext.ttf"
import sansLatin from "./og-fonts/sans-latin.ttf"
import serifCyrillic from "./og-fonts/serif-cyrillic.ttf"
import serifLatinExt from "./og-fonts/serif-latin-ext.ttf"
import serifLatin from "./og-fonts/serif-latin.ttf"
import { makeOgRenderer, type OgFonts, type OgLogo, type OgRender } from "./og-render"
import { type StatusOgImage, StatusOgImageError } from "./ports"

const FONTS: OgFonts = {
	sans: { latin: sansLatin, "latin-ext": sansLatinExt, cyrillic: sansCyrillic },
	serif: { latin: serifLatin, "latin-ext": serifLatinExt, cyrillic: serifCyrillic },
	mono: { latin: monoLatin, "latin-ext": monoLatinExt, cyrillic: monoCyrillic },
}

/** A logo slower or larger than this is drawn as the page name instead. */
const LOGO_TIMEOUT = Duration.seconds(2)
const LOGO_MAX_BYTES = 1024 * 1024
const LOGO_TYPES = /^image\/(png|jpeg|webp|gif|svg\+xml)\b/u

/** Long, because the key changes whenever the card does. */
const CACHE_SECONDS = 7 * 24 * 60 * 60

const NO_LOGO: OgLogo = { _tag: "none" }

/** One renderer per isolate. takumi's wasm initialises once, so only a failed init is retried. */
let renderer: Promise<OgRender> | undefined

const engine = Effect.tryPromise({
	try: () =>
		(renderer ??= makeOgRenderer(async () => {
			await init({ module_or_path: wasmModule })
		}, FONTS)),
	catch: (cause) => new StatusOgImageError({ message: "Starting the preview renderer failed", cause }),
}).pipe(
	Effect.tapError(() =>
		Effect.sync(() => {
			renderer = undefined
		}),
	),
)

const render = (card: StatusOgCard, logo: OgLogo) =>
	engine.pipe(
		Effect.flatMap((draw) =>
			Effect.tryPromise({
				try: () => draw(card, logo),
				catch: (cause) => new StatusOgImageError({ message: "Rendering the preview failed", cause }),
			}),
		),
		Effect.withSpan("status.og_image.render"),
	)

/** A remote logo's outcome: drawn, refused by policy (cacheable), or unreachable this time (not). */
type LogoFetch = OgLogo | { readonly _tag: "unavailable" }

const UNAVAILABLE: LogoFetch = { _tag: "unavailable" }

/** An image type with a declared length under the cap, within the timeout; anything else draws the name. */
const fetchLogo = Effect.fn("status.og_image.logo")(
	function* (url: string) {
		const client = yield* HttpClient.HttpClient
		const response = yield* client.get(url).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
		const type = response.headers["content-type"] ?? ""
		const length = Number(response.headers["content-length"] ?? "NaN")
		if (!LOGO_TYPES.test(type) || !(length > 0 && length <= LOGO_MAX_BYTES)) return NO_LOGO
		const body = yield* response.arrayBuffer
		const logo: LogoFetch = { _tag: "fetched", src: url, data: new Uint8Array(body) }
		return logo
	},
	Effect.timeout(LOGO_TIMEOUT),
	Effect.orElseSucceed(() => UNAVAILABLE),
)

const cacheCall = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new StatusOgImageError({ message: "The preview cache failed", cause }),
	})

/** Cached in `cache` under a synthetic URL per page and card version. */
export const nativeOgImage = (cache: Promise<Cache>, client: HttpClient.HttpClient) =>
	Effect.fn("status.og_image")(function* (key: string, card: StatusOgCard) {
		const cacheKey = `https://status-og.invalid/${encodeURIComponent(key)}`
		const store = yield* cacheCall(() => cache)
		const cached = yield* cacheCall(() => store.match(cacheKey)).pipe(
			Effect.orElseSucceed(() => undefined),
		)
		yield* Effect.annotateCurrentSpan("maple.status_page.og.cache_hit", cached !== undefined)
		if (cached !== undefined) {
			const body = yield* cacheCall(() => cached.arrayBuffer())
			const hit: StatusOgImage = { png: new Uint8Array(body), complete: true }
			return hit
		}
		// An uploaded logo is a `data:` URL takumi decodes itself; only a remote one is fetched.
		const fetched: LogoFetch =
			card.logoUrl === null
				? NO_LOGO
				: Str.startsWith("data:")(card.logoUrl)
					? { _tag: "inline" }
					: yield* fetchLogo(card.logoUrl).pipe(
							Effect.provideService(HttpClient.HttpClient, client),
						)
		yield* Effect.annotateCurrentSpan("maple.status_page.og.logo", fetched._tag)
		const logo = fetched._tag === "unavailable" ? NO_LOGO : fetched
		// A logo takumi cannot draw (an unsupported SVG, say) still leaves a card with the name.
		const drawn = yield* render(card, logo).pipe(
			Effect.map((png) => ({ png, complete: true })),
			Effect.catchTag("@maple/status/OgImageError", (error) =>
				logo._tag === "none"
					? Effect.fail(error)
					: render(card, NO_LOGO).pipe(Effect.map((png) => ({ png, complete: false }))),
			),
		)
		// Only the card as intended is kept; a stand-in is drawn again by the next request.
		const complete = drawn.complete && fetched._tag !== "unavailable"
		if (complete) {
			yield* cacheCall(() =>
				store.put(
					cacheKey,
					new Response(drawn.png, {
						headers: {
							"content-type": "image/png",
							"cache-control": `public, max-age=${CACHE_SECONDS}`,
						},
					}),
				),
			).pipe(Effect.ignore)
		}
		const image: StatusOgImage = { png: drawn.png, complete }
		return image
	})
