import { Effect, Layer, Tracer } from "effect"
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

	it("503s without the binding rather than forwarding over the public internet", async () => {
		const response = await handleRequest(new Request("https://app.maple.test/_api/v2/traces"), {
			ASSETS: assets,
			MAPLE_API_BASE_URL: "https://api.maple.test",
		})
		expect(response.status).toBe(503)
	})

	it("503s without an API, instead of serving the SPA shell", async () => {
		const response = await handleRequest(new Request("https://app.maple.test/_api/v2/traces"), {
			ASSETS: assets,
		})
		expect(response.status).toBe(503)
	})

	it("traces the hop: server span from the browser's traceparent, client span the API parents to", async () => {
		const { env, forwarded } = recordingEnv()
		const spans: Array<Tracer.NativeSpan> = []
		const tracer = Tracer.make({
			span: (options) => {
				const span = new Tracer.NativeSpan(options)
				spans.push(span)
				return span
			},
		})
		const browserTraceId = "0af7651916cd43dd8448eb211c80319c"
		await handleRequest(
			new Request("https://app.maple.test/_api/v2/traces", {
				headers: { traceparent: `00-${browserTraceId}-b7ad6b7169203331-01` },
			}),
			env,
			(effect) => Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(Tracer.Tracer, tracer)))),
		)
		const server = spans.find((span) => span.kind === "server")
		const client = spans.find((span) => span.kind === "client")
		expect(server?.traceId).toBe(browserTraceId)
		expect(server?.attributes.get("http.response.status_code")).toBe(201)
		expect(client?.attributes.get("peer.service")).toBe("maple-api")
		expect(forwarded[0]?.headers.get("traceparent")).toBe(`00-${browserTraceId}-${client?.spanId}-01`)
	})
})
