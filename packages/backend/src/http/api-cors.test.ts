import { describe, expect, it } from "vitest"
import { Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { API_CORS_OPTIONS, apiCorsPreflightResponse } from "./api-cors"

describe("apiCorsPreflightResponse", () => {
	it("stays byte-equivalent to Effect's configured CORS middleware", async () => {
		const probe = HttpRouter.use((router) =>
			router.add("GET", "/probe", HttpServerResponse.text("probe")),
		).pipe(Layer.provideMerge(HttpRouter.cors(API_CORS_OPTIONS)))
		const { handler, dispose } = HttpRouter.toWebHandler(probe, { disableLogger: true })
		try {
			const request = new Request("https://api.example/probe", {
				method: "OPTIONS",
				headers: {
					origin: "https://app.maple.dev",
					"access-control-request-method": "GET",
					"access-control-request-headers": "authorization,content-type",
				},
			})
			const [fast, effect] = await Promise.all([
				Promise.resolve(apiCorsPreflightResponse()),
				handler(request),
			])

			expect(fast.status).toBe(effect.status)
			expect([...fast.headers]).toEqual([...effect.headers])
			expect(await fast.text()).toBe(await effect.text())
		} finally {
			await dispose()
		}
	})
})
