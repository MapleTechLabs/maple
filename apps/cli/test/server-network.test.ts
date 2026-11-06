import { describe, it } from "@effect/vitest"
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert"
import { Effect, Exit, Option, Result, Tracer, Array as Arr, String as Str } from "effect"
import { checkpointQueryUrl } from "@maple/local-server/checkpoints"
import {
	__testables,
	corsHeadersForAllowedOrigin,
	isBrowserOriginAllowed,
	makeBrowserOriginPolicy,
} from "@maple/local-server/serve"
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
			const found = Arr.findFirst(spans, (candidate) => candidate.name === "POST /local/query")
			ok(Option.isSome(found))
			const span = found.value
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
			const found = Arr.findFirst(spans, (candidate) => candidate.name === "POST /local/query")
			ok(Option.isSome(found))
			const span = found.value
			ok(span.status._tag === "Ended" && Exit.isFailure(span.status.exit))
			// Response bodies can quote rows or SQL; only the status reaches the span.
			ok(!Str.includes("database unavailable")(JSON.stringify(exit)))
		}),
	)
})

describe("request admission on shutdown", () => {
	const yieldTurn = () => new Promise((resolve) => setTimeout(resolve, 0))

	it("closes admission, interrupts waiting maintenance, and waits for plain admitted work", async () => {
		const gate = new __testables.RequestQuiescenceGate()
		const leave = gate.enter()
		ok(leave)
		let maintenanceRan = false
		const maintenance = gate.exclusive(async () => {
			maintenanceRan = true
		})
		let drained = false
		const shutdown = gate.shutdown().then((report) => {
			drained = true
			return report
		})
		strictEqual(gate.enter(), null)
		await rejects(
			gate.exclusive(async () => undefined),
			/maintenance operation is active/,
		)
		await rejects(maintenance)
		await yieldTurn()
		strictEqual(drained, false)
		leave()
		const report = await shutdown
		// It was still waiting for admission to drain: nothing in the store changed.
		strictEqual(maintenanceRan, false)
		strictEqual(report.maintenanceInterrupted, false)
		strictEqual(gate.leavesStoreClean(), true)
		strictEqual(gate.enter(), null)
	})

	it("interrupts an admitted request and waits until it has stopped", async () => {
		const gate = new __testables.RequestQuiescenceGate()
		const stopped: Array<string> = []
		const request = Effect.runPromiseExit(
			__testables.admitted(
				gate,
				Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => stopped.push("request")))),
			),
		)
		await yieldTurn()
		await gate.shutdown()
		stopped.push("shutdown")
		strictEqual(Exit.hasInterrupts(await request), true)
		deepStrictEqual(stopped, ["request", "shutdown"])
	})

	it("reports the store unclean only when maintenance was cut off mid-way", async () => {
		const gate = new __testables.RequestQuiescenceGate()
		const completed = new __testables.RequestQuiescenceGate()
		await completed.exclusive(async () => undefined)
		strictEqual((await completed.shutdown()).maintenanceInterrupted, false)
		strictEqual(completed.leavesStoreClean(), true)

		const maintenance = Effect.runPromiseExit(gate.exclusiveEffect(Effect.never))
		await yieldTurn()
		strictEqual(gate.leavesStoreClean(), false)
		const report = await gate.shutdown()
		strictEqual(Exit.hasInterrupts(await maintenance), true)
		strictEqual(report.maintenanceInterrupted, true)
		strictEqual(gate.leavesStoreClean(), false)
	})

	it("reports readiness retries cut short by shutdown as given up", async () => {
		const gate = new __testables.RequestQuiescenceGate()
		const givenUp: Array<number> = []
		const recovery = new __testables.ReadinessRecovery(
			() => {
				throw new Error("readiness not recorded")
			},
			gate,
			(eventCount) => givenUp.push(eventCount),
		)
		recovery.retry(["a", "b"])
		recovery.stop()
		recovery.retry(["c"])
		deepStrictEqual(givenUp, [2, 1])
	})
})

// Bun types `port` as optional (unix sockets); these listeners are always TCP.
const portOf = (server: { readonly port: number | undefined }): number => {
	ok(server.port !== undefined, "listener has no TCP port")
	return server.port
}

describe("local listener addresses", () => {
	it("reaches an IPv4 wildcard listener through the loopback probe URL", async () => {
		const server = Bun.serve({
			hostname: "0.0.0.0",
			port: 0,
			fetch: () => new Response("OK"),
		})
		try {
			const response = await fetch(serverProbeUrl("0.0.0.0", portOf(server)))
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
			strictEqual((await fetch(serverProbeUrl("::1", portOf(server)))).status, 200)
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
			strictEqual((await fetch(serverProbeUrl("::", portOf(server)))).status, 200)
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
		ok(Str.includes("MAPLE_LOCAL_ALLOWED_ORIGINS")(invalid.failure.message))
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

	it("checks the Host of requests without an Origin outside ingest and /health", () => {
		const rebound = "http://rebind.attacker.example:4418"
		for (const path of ["/local/status", "/", "/assets/app.js", "/local/eventing/outbox"])
			strictEqual(allowed(`${rebound}${path}`, null), false, path)
		for (const path of ["/v1/traces", "/health"])
			strictEqual(allowed(`${rebound}${path}`, null), true, path)
		for (const url of [
			"http://127.0.0.1:4318/local/status",
			"http://localhost:4318/local/status",
			"http://[::1]:4318/local/status",
			"https://maple.wt.localhost/local/status",
			"http://node-a.example.test:4418/local/status",
		])
			strictEqual(allowed(url, null), true, url)
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
		const headers = corsHeadersForAllowedOrigin(hostedOrigin)
		strictEqual(headers?.["access-control-allow-origin"], hostedOrigin)
		strictEqual(headers?.vary, "Origin")
		strictEqual(headers?.["access-control-allow-private-network"], "true")
		const loopbackOrigin = "http://localhost:3000"
		strictEqual(allowed("http://127.0.0.1:4318/v1/traces", loopbackOrigin), true)
		strictEqual(
			corsHeadersForAllowedOrigin(loopbackOrigin)?.["access-control-allow-origin"],
			loopbackOrigin,
		)
		strictEqual(corsHeadersForAllowedOrigin(null), undefined)
	})

	it("allows instrumented dashboard requests through the CORS preflight", () => {
		const headers = new Headers(corsHeadersForAllowedOrigin(hostedOrigin))
		const allowHeader = headers.get("access-control-allow-headers")
		const allowedHeaders = new Set<string>(
			allowHeader === null
				? []
				: Arr.map(Str.split(",")(allowHeader), (header) => Str.toLowerCase(Str.trim(header))),
		)
		for (const requested of [
			"content-type",
			"authorization",
			"x-maple-sdk",
			"x-maple-ingest-key",
			"traceparent",
			"tracestate",
			"baggage",
			"b3",
		]) {
			ok(allowedHeaders.has(requested), `preflight must allow ${requested}`)
		}
	})
})
