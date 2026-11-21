/**
 * The page's logo for its link preview, when it is a remote URL: an image type, at most 1 MB as
 * read (not as declared), within 2 seconds. Refusals are the logo's answer; failures may pass.
 */
import { Array as Arr, Duration, Effect, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import type { OgLogo } from "./og-render"

const LOGO_TIMEOUT = Duration.seconds(2)
export const LOGO_MAX_BYTES = 1024 * 1024
const LOGO_TYPES = /^image\/(png|jpeg|webp|gif|svg\+xml)\b/u

export const NO_LOGO: OgLogo = { _tag: "none" }

/** A remote logo's outcome: drawn, refused by policy (cacheable), or unreachable this time (not). */
export type LogoFetch = OgLogo | { readonly _tag: "unavailable" }

const UNAVAILABLE: LogoFetch = { _tag: "unavailable" }

/** The logo's body passed the cap while streaming; the read stops there. */
class LogoTooLarge extends Schema.TaggedError<LogoTooLarge>()("@maple/status/OgLogoTooLarge", {
	message: Schema.String,
}) {}

/** Reads at most `LOGO_MAX_BYTES`, whatever the response declares. */
const readCapped = <E>(stream: Stream.Stream<Uint8Array, E>) =>
	stream.pipe(
		Stream.runFoldEffect(
			() => ({ chunks: new Array<Uint8Array>(), size: 0 }),
			(read, chunk) =>
				read.size + chunk.byteLength > LOGO_MAX_BYTES
					? Effect.fail(new LogoTooLarge({ message: `Logo is over ${LOGO_MAX_BYTES} bytes` }))
					: Effect.sync(() => {
							read.chunks.push(chunk)
							return { chunks: read.chunks, size: read.size + chunk.byteLength }
						}),
		),
		Effect.map(
			(read) =>
				Arr.reduce(read.chunks, { data: new Uint8Array(read.size), at: 0 }, (acc, chunk) => {
					acc.data.set(chunk, acc.at)
					return { data: acc.data, at: acc.at + chunk.byteLength }
				}).data,
		),
	)

/** An image type under the size cap, within the timeout; anything else draws the name. */
export const fetchLogo = Effect.fn("status.og_image.logo")(
	function* (url: string) {
		const client = yield* HttpClient.HttpClient
		const response = yield* client.get(url).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
		const type = response.headers["content-type"] ?? ""
		if (!LOGO_TYPES.test(type)) return NO_LOGO
		const data = yield* readCapped(response.stream)
		const logo: LogoFetch = { _tag: "fetched", src: url, data }
		return logo
	},
	Effect.timeout(LOGO_TIMEOUT),
	// Too large is the logo's answer, kept like a refused type; anything else may pass.
	Effect.catchTag("@maple/status/OgLogoTooLarge", () => Effect.succeed(NO_LOGO)),
	Effect.orElseSucceed(() => UNAVAILABLE),
)
