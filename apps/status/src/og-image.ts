/**
 * `StatusEnv.ogImage` in the Worker: the colo cache first, else load the logo and draw. Each card
 * version renders once per colo; the version is in the cache key, so a status change misses.
 */
import init from "@takumi-rs/wasm"
import wasmModule from "@takumi-rs/wasm/auto"
import type { StatusOgCard } from "@maple/status-page"
import { Effect, Option, String as Str } from "effect"
import { HttpClient } from "effect/http"
import monoCyrillic from "./og-fonts/mono-cyrillic.ttf"
import monoLatinExt from "./og-fonts/mono-latin-ext.ttf"
import monoLatin from "./og-fonts/mono-latin.ttf"
import sansCyrillic from "./og-fonts/sans-cyrillic.ttf"
import sansLatinExt from "./og-fonts/sans-latin-ext.ttf"
import sansLatin from "./og-fonts/sans-latin.ttf"
import serifCyrillic from "./og-fonts/serif-cyrillic.ttf"
import serifLatinExt from "./og-fonts/serif-latin-ext.ttf"
import serifLatin from "./og-fonts/serif-latin.ttf"
import { fetchLogo, inlineLogo, type LogoFetch, NO_LOGO } from "./og-logo"
import { makeOgRenderer, type OgFonts, type OgLogo, type OgRender } from "./og-render"
import { type StatusOgImage, StatusOgImageError } from "./ports"

const FONTS: OgFonts = {
	sans: { latin: sansLatin, "latin-ext": sansLatinExt, cyrillic: sansCyrillic },
	serif: { latin: serifLatin, "latin-ext": serifLatinExt, cyrillic: serifCyrillic },
	mono: { latin: monoLatin, "latin-ext": monoLatinExt, cyrillic: monoCyrillic },
}

/** Long, because the key changes whenever the card does. */
const CACHE_SECONDS = 7 * 24 * 60 * 60

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

const cacheCall = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new StatusOgImageError({ message: "The preview cache failed", cause }),
	})

/** A refused logo (wrong type, too big) may be fixed in place, so its stand-in is kept an hour. */
const REFUSED_CACHE_SECONDS = 60 * 60

/** Marks a cached stand-in, so a hit keeps the short HTTP cache it was first served with. */
const STAND_IN_HEADER = "x-maple-og-stand-in"

/** Cached in `cache` under a synthetic URL per page and card version; no cache is only a miss. */
export const nativeOgImage = (cache: Promise<Cache>, client: HttpClient.HttpClient) =>
	Effect.fn("status.og_image")(function* (key: string, card: StatusOgCard) {
		const cacheKey = `https://status-og.invalid/${encodeURIComponent(key)}`
		const store = yield* cacheCall(() => cache).pipe(Effect.option)
		const cached = Option.isSome(store)
			? yield* cacheCall(() => store.value.match(cacheKey)).pipe(Effect.orElseSucceed(() => undefined))
			: undefined
		const body =
			cached === undefined
				? Option.none<ArrayBuffer>()
				: yield* cacheCall(() => cached.arrayBuffer()).pipe(Effect.option)
		yield* Effect.annotateCurrentSpan("maple.status_page.og.cache_hit", Option.isSome(body))
		if (Option.isSome(body)) {
			const standIn = cached?.headers.get(STAND_IN_HEADER) === "1"
			const hit: StatusOgImage = { png: new Uint8Array(body.value), complete: !standIn }
			return hit
		}
		// An uploaded logo is a `data:` URL; both kinds are held to the same size and pixel limits.
		const fetched: LogoFetch =
			card.logoUrl === null
				? NO_LOGO
				: Str.startsWith("data:")(card.logoUrl)
					? inlineLogo(card.logoUrl)
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
		// A stand-in for a logo that failed this time is not kept; one for a refused logo briefly.
		const refused = card.logoUrl !== null && fetched._tag === "none"
		const keep = drawn.complete && fetched._tag !== "unavailable"
		if (keep && Option.isSome(store)) {
			yield* cacheCall(() =>
				store.value.put(
					cacheKey,
					new Response(drawn.png, {
						headers: {
							"content-type": "image/png",
							"cache-control": `public, max-age=${refused ? REFUSED_CACHE_SECONDS : CACHE_SECONDS}`,
							[STAND_IN_HEADER]: refused ? "1" : "0",
						},
					}),
				),
			).pipe(Effect.ignore)
		}
		const image: StatusOgImage = { png: drawn.png, complete: keep && !refused }
		return image
	})
