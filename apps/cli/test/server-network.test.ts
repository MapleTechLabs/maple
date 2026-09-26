import { describe, it } from "@effect/vitest"
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert"
import { Effect, Exit, Result, Tracer } from "effect"
import { checkpointQueryUrl } from "../src/server/checkpoints"
import {
	__testables,
	corsHeadersForAllowedOrigin,
	isBrowserOriginAllowed,
	makeBrowserOriginPolicy,
} from "../src/server/serve"
import { serverProbeUrl } from "../src/commands/server-args"

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

describe("local HTTP server span status", () => {
	it.effect("records a 4xx response as a successful Server span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const response = yield* __testables
				.recordServerResponse(new Response("invalid SQL", { status: 400 }))
				.pipe(Effect.withSpan("POST /local/query", { kind: "server" }), Effect.withTracer(tracer))

			strictEqual(response.status, 400)
			const span = spans.find((candidate) => candidate.name === "POST /local/query")
			ok(span)
			strictEqual(span.attributes.get("error.type"), "HTTP 400")
			ok(span.status._tag === "Ended" && Exit.isSuccess(span.status.exit))
		}),
	)

	it.effect("records a 5xx response as a failed Server span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const exit = yield* __testables
				.recordServerResponse(new Response("database unavailable", { status: 503 }))
				.pipe(
					Effect.withSpan("POST /local/query", { kind: "server" }),
					Effect.withTracer(tracer),
					Effect.exit,
				)

			ok(Exit.isFailure(exit))
			const span = spans.find((candidate) => candidate.name === "POST /local/query")
			ok(span)
			ok(span.status._tag === "Ended" && Exit.isFailure(span.status.exit))
			// Response bodies can quote rows or SQL; only the status reaches the span.
			ok(!JSON.stringify(exit).includes("database unavailable"))
		}),
	)
})

describe("request admission on shutdown", () => {
	it("closes admission and waits for admitted and exclusive work", async () => {
		const gate = new __testables.RequestQuiescenceGate()
		const leave = gate.enter()
		ok(leave)
		let releaseMaintenance = () => {}
		const maintenance = gate.exclusive(
			() =>
				new Promise<void>((resolve) => {
					releaseMaintenance = resolve
				}),
		)
		let drained = false
		const shutdown = gate.shutdown().then(() => {
			drained = true
		})
		strictEqual(gate.enter(), null)
		await rejects(
			gate.exclusive(async () => undefined),
			/maintenance operation is active/,
		)
		leave()
		await new Promise((resolve) => setTimeout(resolve, 0))
		strictEqual(drained, false)
		releaseMaintenance()
		await maintenance
		await shutdown
		strictEqual(drained, true)
		// Admission stays closed after maintenance finishes during shutdown.
		strictEqual(gate.enter(), null)
	})
})

describe("local listener addresses", () => {
	it("reaches an IPv4 wildcard listener through the loopback probe URL", async () => {
		const server = Bun.serve({
			hostname: "0.0.0.0",
			port: 0,
			fetch: () => new Response("OK"),
		})
		try {
			const response = await fetch(serverProbeUrl("0.0.0.0", server.port))
			strictEqual(response.status, 200)
		} finally {
			await server.stop(true)
		}
	})

	it("does not assume IPv4 loopback for an IPv6-only listener", async () => {
		const server = Bun.serve({
			hostname: "::1",
			port: 0,
			fetch: () => new Response("OK"),
		})
		try {
			strictEqual((await fetch(serverProbeUrl("::1", server.port))).status, 200)
			await rejects(fetch(`http://127.0.0.1:${server.port}`))
		} finally {
			await server.stop(true)
		}
	})

	it("reaches an IPv6 wildcard listener through IPv6 loopback", async () => {
		const server = Bun.serve({
			hostname: "::",
			port: 0,
			fetch: () => new Response("OK"),
		})
		try {
			strictEqual((await fetch(serverProbeUrl("::", server.port))).status, 200)
		} finally {
			await server.stop(true)
		}
	})

	it("formats checkpoint query URLs for the resolved connection host", () => {
		strictEqual(checkpointQueryUrl("::1", 4418), "http://[::1]:4418/local/query")
	})
})

describe("browser origin policy", () => {
	const requestUrl = new URL("http://node-a.example.test:4418/local/query")
	const hostedOrigin = "https://local.maple.dev"
	const browserHosts = ["node-a.example.test", "127.0.0.1"]
	const makePolicy = (options: { hostedOrigin?: string; extraOrigins?: string; hosts?: string[] } = {}) => {
		const policy = makeBrowserOriginPolicy({
			browserHosts: options.hosts ?? browserHosts,
			hostedOrigin: "hostedOrigin" in options ? options.hostedOrigin : hostedOrigin,
			extraOrigins: options.extraOrigins,
		})
		ok(Result.isSuccess(policy))
		return policy.success
	}
	const allowed = (url: URL | string, origin: string | null, policy = makePolicy()) =>
		isBrowserOriginAllowed(typeof url === "string" ? new URL(url) : url, origin, policy)

	it("allows non-browser clients, the advertised same-origin UI, and the hosted UI", () => {
		strictEqual(allowed(requestUrl, null), true)
		strictEqual(allowed(requestUrl, "http://node-a.example.test:4418"), true)
		strictEqual(allowed(requestUrl, "https://node-a.example.test:4418"), true)
		strictEqual(allowed(requestUrl, hostedOrigin), true)
	})

	it("allows loopback aliases of this listener and the local-ui Vite origin", () => {
		const hosts = ["127.0.0.1"]
		strictEqual(
			allowed("http://localhost:4318/local/query", "http://localhost:4318", makePolicy({ hosts })),
			true,
		)
		strictEqual(
			allowed("http://127.0.0.1:4318/local/query", "http://127.0.0.1:4319", makePolicy({ hosts })),
			true,
		)
		strictEqual(
			allowed("http://[::1]:4318/local/query", "http://[::1]:4319", makePolicy({ hosts: ["[::1]"] })),
			true,
		)
	})

	it("refuses other local dev servers on the query and admin API", () => {
		for (const origin of ["http://localhost:3000", "http://127.0.0.1:5173", "https://app.localhost"]) {
			strictEqual(allowed("http://127.0.0.1:4318/local/query", origin), false, origin)
			strictEqual(allowed("http://127.0.0.1:4318/local/status", origin), false, origin)
			strictEqual(allowed("http://127.0.0.1:4318/local/eventing/claims", origin), false, origin)
		}
	})

	it("keeps OTLP ingest open to browser SDKs on loopback pages", () => {
		strictEqual(allowed("http://127.0.0.1:4318/v1/traces", "http://localhost:3000"), true)
		strictEqual(allowed("http://127.0.0.1:4318/v1/logs", "https://app.localhost"), true)
		strictEqual(allowed("http://node-a.example.test:4418/v1/traces", "http://localhost:3000"), false)
	})

	it("honours explicitly allowed origins and rejects malformed ones", () => {
		const policy = makePolicy({ extraOrigins: " http://localhost:5173/ , https://tools.example.test" })
		strictEqual(allowed("http://127.0.0.1:4318/local/query", "http://localhost:5173", policy), true)
		strictEqual(allowed("http://127.0.0.1:4318/local/query", "https://tools.example.test", policy), true)
		const invalid = makeBrowserOriginPolicy({ browserHosts, extraOrigins: "not a url" })
		ok(Result.isFailure(invalid))
		ok(invalid.failure.message.includes("MAPLE_LOCAL_ALLOWED_ORIGINS"))
	})

	it("accepts no hosted origin when the hosted UI is disabled", () => {
		for (const hosted of [undefined, ""]) {
			const policy = makePolicy({ hostedOrigin: hosted })
			strictEqual(
				allowed("http://127.0.0.1:4318/local/query", "https://local.maple.dev", policy),
				false,
			)
			strictEqual(allowed("http://127.0.0.1:4318/local/query", "http://127.0.0.1:4318", policy), true)
		}
	})

	it("rejects arbitrary and DNS-rebinding browser origins", () => {
		strictEqual(allowed(requestUrl, "https://attacker.example"), false)
		strictEqual(
			allowed("http://rebind.attacker.example:4418/local/query", "http://rebind.attacker.example:4418"),
			false,
		)
		strictEqual(allowed(requestUrl, "http://localhost:4319"), false)
		strictEqual(allowed(requestUrl, "null"), false)
	})

	it("echoes any allowed origin instead of a wildcard", () => {
		deepStrictEqual(corsHeadersForAllowedOrigin(hostedOrigin), {
			"access-control-allow-origin": hostedOrigin,
			"access-control-allow-methods": "GET, POST, OPTIONS",
			"access-control-allow-headers": "content-type, content-encoding, authorization, x-maple-sdk",
			"access-control-allow-private-network": "true",
			vary: "Origin",
		})
		const loopbackOrigin = "http://localhost:3000"
		strictEqual(allowed("http://127.0.0.1:4318/v1/traces", loopbackOrigin), true)
		strictEqual(
			corsHeadersForAllowedOrigin(loopbackOrigin)?.["access-control-allow-origin"],
			loopbackOrigin,
		)
		strictEqual(corsHeadersForAllowedOrigin(null), undefined)
	})

	it("allows the Authorization header browser SDKs send when an ingest key is set", () => {
		// A page bundled for hosted Maple carries `Authorization: Bearer maple_pk_…`
		// on every OTLP post. Omitting the header here failed preflight and blocked
		// the page from reaching local mode at all.
		strictEqual(
			corsHeadersForAllowedOrigin("http://localhost:4501")
				?.["access-control-allow-headers"].split(", ")
				.includes("authorization"),
			true,
		)
	})

	it("allows the x-maple-sdk identity hint every browser SDK sends", () => {
		// Same failure mode as `authorization`: a header the SDK always sends that
		// preflight refuses blocks every request from that SDK, not just the header.
		strictEqual(
			corsHeadersForAllowedOrigin("http://localhost:4501")
				?.["access-control-allow-headers"].split(", ")
				.includes("x-maple-sdk"),
			true,
		)
	})
})
