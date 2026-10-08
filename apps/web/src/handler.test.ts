import { describe, expect, it } from "vitest"
import { apiProxyPath } from "./api-proxy"
import { handleRequest } from "./handler"
import type { WebWorkerEnv } from "./worker-env"

const assets = {
	fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
}

const recordingEnv = () => {
	const forwarded: Array<Request> = []
	const env: WebWorkerEnv = {
		ASSETS: assets,
		MAPLE_API_BASE_URL: "https://api.maple.test",
		API: {
			fetch: async (request) => {
				forwarded.push(request)
				return new Response("from-api", { status: 201 })
			},
		},
	}
	return { env, forwarded }
}

describe("apiProxyPath", () => {
	it("strips the prefix, and only a whole segment of it", () => {
		expect(apiProxyPath("/_api/v2/traces")).toBe("/v2/traces")
		expect(apiProxyPath("/_api")).toBe("/")
		expect(apiProxyPath("/_apikeys")).toBeUndefined()
		expect(apiProxyPath("/api/chat")).toBeUndefined()
	})
})

describe("handleRequest API proxy", () => {
	it("forwards to the API's own URL with method, headers, body and query", async () => {
		const { env, forwarded } = recordingEnv()
		const response = await handleRequest(
			new Request("https://app.maple.test/_api/api/chat/sessions/s1?x=1", {
				method: "POST",
				headers: { authorization: "Bearer t", "cf-connecting-ip": "203.0.113.7" },
				body: "hello",
			}),
			env,
		)
		expect(response.status).toBe(201)
		expect(await response.text()).toBe("from-api")
		const [request] = forwarded
		expect(request?.url).toBe("https://api.maple.test/api/chat/sessions/s1?x=1")
		expect(request?.method).toBe("POST")
		expect(request?.headers.get("authorization")).toBe("Bearer t")
		expect(request?.headers.get("cf-connecting-ip")).toBe("203.0.113.7")
		expect(await request?.text()).toBe("hello")
	})

	it("never leaves the API's host for a protocol-relative path", async () => {
		const { env, forwarded } = recordingEnv()
		await handleRequest(new Request("https://app.maple.test/_api//evil.test/steal"), env)
		expect(new URL(forwarded[0]?.url ?? "").host).toBe("api.maple.test")
	})

	it("404s without an API, instead of serving the SPA shell", async () => {
		const response = await handleRequest(new Request("https://app.maple.test/_api/v2/traces"), {
			ASSETS: assets,
		})
		expect(response.status).toBe(404)
	})
})
