/**
 * The page's logo for its link preview: an image type, at most 1 MB as read (not as declared) and
 * 4 megapixels as decoded, fetched within 2 seconds. Refusals are the logo's answer; failures may pass.
 */
import { Array as Arr, Duration, Effect, Result, Schema, Stream, String as Str } from "effect"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientResponse } from "effect/http"
import type { OgLogo } from "./og-render"

const LOGO_TIMEOUT = Duration.seconds(2)
export const LOGO_MAX_BYTES = 1024 * 1024
const LOGO_TYPES = /^image\/(png|jpeg|webp|gif|svg\+xml)\b/u

export const NO_LOGO: OgLogo = { _tag: "none" }

/** Decoded to RGBA a logo costs 4 bytes a pixel; this keeps it near 16 MB in a 128 MB isolate. */
export const LOGO_MAX_PIXELS = 4_000_000

const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
const u16le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, at: number): number => u16le(b, at) | ((b[at + 2] ?? 0) << 16)
const u32be = (b: Uint8Array, at: number): number => u16be(b, at) * 65_536 + u16be(b, at + 2)
const ascii = (b: Uint8Array, at: number, text: string): boolean =>
	Arr.every(Array.from(new TextEncoder().encode(text)), (byte, index) => b[at + index] === byte)

/** JPEG: the first start-of-frame marker carries height then width. */
const jpegPixels = (b: Uint8Array): number | null => {
	let at = 2
	while (at + 9 < b.length && b[at] === 0xff) {
		const marker = b[at + 1] ?? 0
		const isFrame =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
		if (isFrame) return u16be(b, at + 5) * u16be(b, at + 7)
		at += 2 + u16be(b, at + 2)
	}
	return null
}

/** Width times height from a PNG, GIF, WebP or JPEG header; null when it is none of those. */
export const imagePixels = (b: Uint8Array): number | null => {
	if (ascii(b, 1, "PNG") && ascii(b, 12, "IHDR")) return u32be(b, 16) * u32be(b, 20)
	if (ascii(b, 0, "GIF8")) return u16le(b, 6) * u16le(b, 8)
	if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) {
		if (ascii(b, 12, "VP8 ")) return (u16le(b, 26) & 0x3fff) * (u16le(b, 28) & 0x3fff)
		if (ascii(b, 12, "VP8X")) return (u24le(b, 24) + 1) * (u24le(b, 27) + 1)
		if (ascii(b, 12, "VP8L")) {
			const bits = u16le(b, 21) | (u16le(b, 23) * 65_536)
			return ((bits & 0x3fff) + 1) * (((bits >>> 14) & 0x3fff) + 1)
		}
		return null
	}
	if (b[0] === 0xff && b[1] === 0xd8) return jpegPixels(b)
	return null
}

/** SVG rasterises at the card's size; a bitmap is kept only when its header proves it small enough. */
export const acceptLogo = (src: string, type: string, data: Uint8Array): OgLogo => {
	if (Str.startsWith("image/svg+xml")(type)) return { _tag: "fetched", src, data }
	const pixels = imagePixels(data)
	return pixels !== null && pixels > 0 && pixels <= LOGO_MAX_PIXELS
		? { _tag: "fetched", src, data }
		: NO_LOGO
}

/** An uploaded logo, a base64 `data:` URL, held to the same limits as a fetched one. */
export const inlineLogo = (dataUrl: string): OgLogo => {
	const match = /^data:([^;,]+);base64,(.*)$/su.exec(dataUrl)
	if (match === null) return NO_LOGO
	const decoded = Base64.decode(match[2] ?? "")
	return Result.isSuccess(decoded) ? acceptLogo(dataUrl, match[1] ?? "", decoded.success) : NO_LOGO
}

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
		// One fixed name for every logo host: customers' domains would flood the service map.
		yield* Effect.annotateCurrentSpan("peer.service", "status-logo")
		const client = yield* HttpClient.HttpClient
		const response = yield* client.get(url).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
		const type = response.headers["content-type"] ?? ""
		if (!LOGO_TYPES.test(type)) return NO_LOGO
		const data = yield* readCapped(response.stream)
		const logo: LogoFetch = acceptLogo(url, type, data)
		return logo
	},
	Effect.timeout(LOGO_TIMEOUT),
	// Too large is the logo's answer, kept like a refused type; anything else may pass.
	Effect.catchTag("@maple/status/OgLogoTooLarge", () => Effect.succeed(NO_LOGO)),
	Effect.orElseSucceed(() => UNAVAILABLE),
)
