import { Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import { fetchLogo, imagePixels, inlineLogo, LOGO_MAX_BYTES } from "./og-logo"

const CHUNK = 64 * 1024

/** A body served in 64 KB chunks, counting how many the reader pulled. */
const chunked = (total: number) => {
	const pulled = { count: 0 }
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const sent = pulled.count * CHUNK
			if (sent >= total) return controller.close()
			pulled.count++
			const chunk = new Uint8Array(Math.min(CHUNK, total - sent)).fill(7)
			// A real image header up front, so the body passes as a small PNG.
			if (sent === 0) chunk.set(png(600, 160))
			controller.enqueue(chunk)
		},
	})
	return { body, pulled }
}

const fetchWith = (respond: () => Response) =>
	Effect.runPromise(
		fetchLogo("https://acme.example/logo.png").pipe(
			Effect.provideService(
				HttpClient.HttpClient,
				HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, respond()))),
			),
		),
	)

describe("fetching a page's logo for its preview", () => {
	it("reads a chunked image with no declared length", async () => {
		const { body } = chunked(3 * CHUNK + 10)
		const logo = await fetchWith(() => new Response(body, { headers: { "content-type": "image/png" } }))
		expect(logo._tag).toBe("fetched")
		expect(logo._tag === "fetched" ? logo.data.byteLength : 0).toBe(3 * CHUNK + 10)
	})

	it("stops reading at the cap, whatever length the response declares", async () => {
		const { body, pulled } = chunked(LOGO_MAX_BYTES * 4)
		const logo = await fetchWith(
			() => new Response(body, { headers: { "content-type": "image/png", "content-length": "100" } }),
		)
		expect(logo._tag).toBe("none")
		expect(pulled.count).toBeLessThan((LOGO_MAX_BYTES * 2) / CHUNK)
	})

	it("refuses a response that is not an image", async () => {
		const logo = await fetchWith(
			() => new Response("<html>", { headers: { "content-type": "text/html" } }),
		)
		expect(logo._tag).toBe("none")
	})

	it("treats a server error as unavailable this time, not as no logo", async () => {
		const logo = await fetchWith(() => new Response("down", { status: 503 }))
		expect(logo._tag).toBe("unavailable")
	})

	it("treats a network failure as unavailable", async () => {
		const logo = await Effect.runPromise(
			fetchLogo("https://acme.example/logo.png").pipe(
				Effect.provideService(
					HttpClient.HttpClient,
					HttpClient.make((request) =>
						Effect.fail(
							new HttpClientError.HttpClientError({
								reason: new HttpClientError.TransportError({
									request,
									description: "connection reset",
								}),
							}),
						),
					),
				),
			),
		)
		expect(logo._tag).toBe("unavailable")
	})
})

/** Image headers with the given size, as each format writes it. */
const png = (width: number, height: number) => {
	const b = new Uint8Array(33)
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
	new DataView(b.buffer).setUint32(16, width)
	new DataView(b.buffer).setUint32(20, height)
	return b
}
const gif = (width: number, height: number) => {
	const b = new Uint8Array(13)
	b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
	new DataView(b.buffer).setUint16(6, width, true)
	new DataView(b.buffer).setUint16(8, height, true)
	return b
}
const jpeg = (width: number, height: number) => {
	// SOI, an APP0 segment to skip, then a baseline frame header.
	const b = new Uint8Array([
		0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 0, 0, 0,
	])
	new DataView(b.buffer).setUint16(13, height)
	new DataView(b.buffer).setUint16(15, width)
	return b
}
const riff = (chunk: string, body: ReadonlyArray<number>) =>
	new Uint8Array([...new TextEncoder().encode(`RIFF\0\0\0\0WEBP${chunk}`), ...body])
const webpX = (width: number, height: number) => {
	const b = riff(
		"VP8X",
		Array.from({ length: 18 }, () => 0),
	)
	new DataView(b.buffer).setUint32(24, width - 1, true)
	new DataView(b.buffer).setUint32(27, height - 1, true)
	return b
}
const webpLossy = (width: number, height: number) => {
	const b = riff(
		"VP8 ",
		Array.from({ length: 18 }, () => 0),
	)
	new DataView(b.buffer).setUint16(26, width, true)
	new DataView(b.buffer).setUint16(28, height, true)
	return b
}
const webpLossless = (width: number, height: number) => {
	const b = riff(
		"VP8L",
		Array.from({ length: 13 }, () => 0),
	)
	new DataView(b.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true)
	return b
}

describe("reading a logo's size from its header", () => {
	it("reads PNG, GIF, JPEG and each WebP kind", () => {
		expect(imagePixels(png(400, 100))).toBe(40_000)
		expect(imagePixels(gif(300, 60))).toBe(18_000)
		expect(imagePixels(jpeg(640, 480))).toBe(307_200)
		expect(imagePixels(webpX(512, 128))).toBe(65_536)
		expect(imagePixels(webpLossy(200, 50))).toBe(10_000)
		expect(imagePixels(webpLossless(1000, 250))).toBe(250_000)
	})

	it("knows nothing about bytes that are no image it reads", () => {
		expect(imagePixels(new TextEncoder().encode("<html>not an image</html>"))).toBeNull()
	})
})

describe("holding a logo to the decoded-size budget", () => {
	it("refuses a small file that would decode to a huge bitmap", async () => {
		const logo = await fetchWith(
			() => new Response(png(8192, 8192), { headers: { "content-type": "image/png" } }),
		)
		expect(logo._tag).toBe("none")
	})

	it("keeps a normal logo", async () => {
		const logo = await fetchWith(
			() => new Response(png(600, 160), { headers: { "content-type": "image/png" } }),
		)
		expect(logo._tag).toBe("fetched")
	})

	it("holds an uploaded logo to the same budget", () => {
		const dataUrl = (bytes: Uint8Array) => `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`
		expect(inlineLogo(dataUrl(png(8192, 8192)))._tag).toBe("none")
		expect(inlineLogo(dataUrl(png(600, 160)))._tag).toBe("fetched")
	})

	it("keeps an SVG, which is drawn at the card's size", () => {
		const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="99999" height="99999"/>')}`
		expect(inlineLogo(svg)._tag).toBe("fetched")
	})
})
