import { Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import { fetchLogo, LOGO_MAX_BYTES } from "./og-logo"

const CHUNK = 64 * 1024

/** A body served in 64 KB chunks, counting how many the reader pulled. */
const chunked = (total: number) => {
	const pulled = { count: 0 }
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const sent = pulled.count * CHUNK
			if (sent >= total) return controller.close()
			pulled.count++
			controller.enqueue(new Uint8Array(Math.min(CHUNK, total - sent)).fill(7))
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
