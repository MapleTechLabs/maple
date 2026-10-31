import { createServer, type Server } from "node:net"
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { UptimeTcpConfig } from "@maple/domain/uptime"
import { HostResolver } from "@maple/safe-fetch/dns"
import { fixedResolver } from "./testing/uptime"
import type { UptimeFailureType } from "./UptimeProbe"
import { dialTcp, type DialTcp, TcpDialer, UptimeTcpProbe } from "./UptimeTcpProbe"

const decodeConfig = Schema.decodeUnknownSync(UptimeTcpConfig)
const tcpConfig = (host: string, port: number, timeoutMs = 5_000) =>
	decodeConfig({ _tag: "tcp", host, port, timeoutMs })

const portOf = (server: Server): number => {
	const address = server.address()
	return address !== null && typeof address === "object" ? address.port : 0
}

/** A loopback listener for the scope, on an ephemeral port. */
const listener = Effect.acquireRelease(
	Effect.callback<Server>((resume) => {
		const server = createServer((socket) => socket.destroy())
		server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
	}),
	(server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
)

/** A port nothing listens on: bound, then released. */
const closedPort = Effect.scoped(Effect.map(listener, portOf))

const DNS = new Map([
	["db.example.com", ["93.184.216.34"]],
	["internal.example.com", ["93.184.216.34", "10.0.0.5"]],
])

const probeLayer = (dial: DialTcp) =>
	UptimeTcpProbe.layer.pipe(
		Layer.provide(Layer.succeed(HostResolver, fixedResolver(DNS))),
		Layer.provide(Layer.succeed(TcpDialer, dial)),
	)

const recordingDialer =
	(dialled: Array<string>, result: Effect.Effect<void, never> = Effect.void): DialTcp =>
	(address, port) =>
		Effect.suspend(() => {
			dialled.push(`${address}:${port}`)
			return result
		})

const probe = (config: ReturnType<typeof tcpConfig>) =>
	Effect.gen(function* () {
		const tcp = yield* UptimeTcpProbe
		return yield* tcp.probe(config)
	})

describe("dialTcp", () => {
	it.live("connects to a listening port", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const server = yield* listener
				yield* dialTcp("127.0.0.1", portOf(server))
			}),
		),
	)

	it.live("fails with the system code when the port is closed", () =>
		Effect.gen(function* () {
			const port = yield* closedPort
			const error = yield* Effect.flip(dialTcp("127.0.0.1", port))
			assert.strictEqual(error.code, "ECONNREFUSED")
		}),
	)
})

describe("UptimeTcpProbe", () => {
	it.live("a probe through the real dialer reports a refused port as one sentence", () =>
		Effect.gen(function* () {
			const port = yield* closedPort
			// The guard passes the public answer; the test dialer then forwards to a closed loopback port.
			const forward: DialTcp = () => dialTcp("127.0.0.1", port)
			const outcome = yield* probe(tcpConfig("db.example.com", 5432)).pipe(
				Effect.provide(probeLayer(forward)),
			)
			assert.deepStrictEqual(
				{ ok: outcome.ok, error: outcome.error, type: outcome.errorType },
				{ ok: false, error: "Connection refused by db.example.com:5432", type: "connection_refused" },
			)
		}),
	)

	it.live("is up when the connection opens", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const server = yield* listener
				const forward: DialTcp = () => dialTcp("127.0.0.1", portOf(server))
				const outcome = yield* probe(tcpConfig("db.example.com", 5432)).pipe(
					Effect.provide(probeLayer(forward)),
				)
				assert.deepStrictEqual({ ok: outcome.ok, error: outcome.error }, { ok: true, error: null })
			}),
		),
	)

	it.effect("dials the address it resolved", () =>
		Effect.gen(function* () {
			const dialled: Array<string> = []
			const outcome = yield* probe(tcpConfig("db.example.com", 5432)).pipe(
				Effect.provide(probeLayer(recordingDialer(dialled))),
			)
			assert.isTrue(outcome.ok)
			assert.deepStrictEqual(dialled, ["93.184.216.34:5432"])
		}),
	)

	it.effect("refuses private literals, blocked names and private answers without dialling", () =>
		Effect.gen(function* () {
			const dialled: Array<string> = []
			const layer = probeLayer(recordingDialer(dialled))
			const outcomes = yield* Effect.forEach(
				[
					"127.0.0.1",
					"10.1.2.3",
					"::1",
					"localhost",
					"metadata.google.internal",
					"internal.example.com",
				],
				(host) => probe(tcpConfig(host, 22)).pipe(Effect.provide(layer)),
			)
			assert.deepStrictEqual(
				outcomes.map((outcome) => outcome.errorType),
				Array.from({ length: 6 }, (): UptimeFailureType => "ssrf_refused"),
			)
			assert.include(outcomes[5]?.error ?? "", "internal.example.com resolves to a loopback")
			assert.lengthOf(dialled, 0)
		}),
	)

	it.effect("treats a bracketed IPv6 host as an address: public is dialled, private refused", () =>
		Effect.gen(function* () {
			const dialled: Array<string> = []
			const layer = probeLayer(recordingDialer(dialled))
			const publicV6 = yield* probe(tcpConfig("[2606:4700::6810:84e5]", 443)).pipe(
				Effect.provide(layer),
			)
			assert.isTrue(publicV6.ok)
			assert.deepStrictEqual(dialled, ["2606:4700::6810:84e5:443"])
			const privateV6 = yield* probe(tcpConfig("[fd12:3456:789a::1]", 443)).pipe(Effect.provide(layer))
			assert.strictEqual(privateV6.errorType, "ssrf_refused")
			assert.lengthOf(dialled, 1)
		}),
	)

	it.effect("names an unresolvable host", () =>
		Effect.gen(function* () {
			const outcome = yield* probe(tcpConfig("gone.example.net", 22)).pipe(
				Effect.provide(probeLayer(recordingDialer([]))),
			)
			assert.deepStrictEqual(
				{ error: outcome.error, type: outcome.errorType },
				{ error: "Couldn't resolve gone.example.net", type: "dns" },
			)
		}),
	)

	it.effect("times out after the configured timeout", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				probe(tcpConfig("db.example.com", 5432, 3_000)).pipe(
					Effect.provide(probeLayer(recordingDialer([], Effect.never))),
				),
			)
			yield* TestClock.adjust(Duration.seconds(3))
			const outcome = yield* Fiber.join(fiber)
			assert.deepStrictEqual(
				{ error: outcome.error, type: outcome.errorType },
				{ error: "Connection timed out after 3 s", type: "timeout" },
			)
		}),
	)
})
