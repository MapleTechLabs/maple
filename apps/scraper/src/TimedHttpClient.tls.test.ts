import * as tls from "node:tls"
import { X509Certificate } from "node:crypto"
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Duration, Effect, Ref } from "effect"
import { DialServerName } from "@maple/safe-fetch"
import { TEST_TLS_CERT as CERT, TEST_TLS_KEY as KEY } from "./testing/tls"
import { peerCertificate, timedHttpClient } from "./TimedHttpClient"
import { CertificateRecorder } from "./UptimePhases"
import type { UptimeCertificate } from "@maple/domain/uptime"

const EXPECTED: UptimeCertificate = {
	expiresAt: new X509Certificate(CERT).validToDate.getTime(),
	subject: "uptime.test",
	issuer: "uptime.test",
}

/** A loopback TLS server for the scope; `onSecure` decides what each completed connection gets. */
const tlsServer = (onSecure: (socket: tls.TLSSocket) => void) => {
	const open = new Set<tls.TLSSocket>()
	return Effect.acquireRelease(
		Effect.callback<{ readonly server: tls.Server; readonly port: number }>((resume) => {
			const server = tls.createServer({ cert: CERT, key: KEY }, (socket) => {
				open.add(socket)
				onSecure(socket)
			})
			server.listen(0, "127.0.0.1", () => {
				const address = server.address()
				resume(
					Effect.succeed({
						server,
						port: address !== null && typeof address === "object" ? address.port : 0,
					}),
				)
			})
		}),
		({ server }) =>
			Effect.callback<void>((resume) => {
				open.forEach((socket) => socket.destroy())
				server.close(() => resume(Effect.void))
			}),
	)
}

/** Runs one GET through the timed client at the test server, returning what it recorded. */
const recordingGet = (port: number, timeout: Duration.Input) =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<ReadonlyArray<UptimeCertificate | null>>([])
		const result = yield* timedHttpClient.get(`https://127.0.0.1:${port}/`).pipe(
			Effect.timeout(timeout),
			Effect.scoped,
			Effect.result,
			Effect.provideService(CertificateRecorder, (certificate) =>
				Ref.update(seen, (all) => [...all, certificate]),
			),
			Effect.provideService(DialServerName, "uptime.test"),
		)
		return { result, certificates: yield* Ref.get(seen) }
	})

describe("timedHttpClient over TLS", () => {
	// The test certificate is trusted for this file only.
	const defaults = tls.getCACertificates("default")
	beforeAll(() => tls.setDefaultCACertificates([...defaults, CERT]))
	afterAll(() => tls.setDefaultCACertificates(defaults))

	it.live("reads the leaf's expiry, subject and issuer off a completed handshake", () =>
		Effect.gen(function* () {
			const { port } = yield* tlsServer((socket) => socket.end())
			const socket = yield* Effect.acquireRelease(
				Effect.callback<tls.TLSSocket>((resume) => {
					const client = tls.connect({ host: "127.0.0.1", port, servername: "uptime.test" }, () =>
						resume(Effect.succeed(client)),
					)
				}),
				(client) => Effect.sync(() => client.destroy()),
			)
			assert.deepStrictEqual(peerCertificate(socket), EXPECTED)
		}).pipe(Effect.scoped),
	)

	it.live("reports the certificate of a handshake whose connection is reset before the headers", () =>
		Effect.gen(function* () {
			const { port } = yield* tlsServer((socket) => socket.destroy())
			const { result, certificates } = yield* recordingGet(port, Duration.seconds(5))
			assert.strictEqual(result._tag, "Failure")
			assert.deepStrictEqual(certificates, [EXPECTED])
		}).pipe(Effect.scoped),
	)

	it.live(
		"reports the certificate of a handshake whose server never answers, once the check times out",
		() =>
			Effect.gen(function* () {
				const { port } = yield* tlsServer(() => undefined)
				const { result, certificates } = yield* recordingGet(port, Duration.millis(300))
				assert.strictEqual(result._tag, "Failure")
				assert.deepStrictEqual(certificates, [EXPECTED])
			}).pipe(Effect.scoped),
	)

	it.live("reports the certificate once with a response", () =>
		Effect.gen(function* () {
			const { port } = yield* tlsServer((socket) =>
				socket.once("data", () => socket.end("HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n")),
			)
			const { result, certificates } = yield* recordingGet(port, Duration.seconds(5))
			assert.strictEqual(result._tag, "Success")
			assert.deepStrictEqual(certificates, [EXPECTED])
		}).pipe(Effect.scoped),
	)
})
