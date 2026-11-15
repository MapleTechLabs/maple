import * as tls from "node:tls"
import { X509Certificate } from "node:crypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TEST_TLS_CERT as CERT, TEST_TLS_KEY as KEY } from "./testing/tls"
import { peerCertificate } from "./TimedHttpClient"

/** A loopback TLS server for the scope and a client socket that trusts it, once the handshake is done. */
const handshake = Effect.acquireRelease(
	Effect.callback<{ readonly server: tls.Server; readonly socket: tls.TLSSocket }>((resume) => {
		const server = tls.createServer({ cert: CERT, key: KEY }, (peer) => peer.end())
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			const port = address !== null && typeof address === "object" ? address.port : 0
			const socket = tls.connect({ host: "127.0.0.1", port, servername: "uptime.test", ca: CERT }, () =>
				resume(Effect.succeed({ server, socket })),
			)
		})
	}),
	({ server, socket }) =>
		Effect.callback<void>((resume) => {
			socket.destroy()
			server.close(() => resume(Effect.void))
		}),
)

describe("peerCertificate", () => {
	it.live("reads the leaf's expiry, subject and issuer off a completed handshake", () =>
		Effect.gen(function* () {
			const { socket } = yield* handshake
			assert.deepStrictEqual(peerCertificate(socket), {
				expiresAt: Date.parse(new X509Certificate(CERT).validTo),
				subject: "uptime.test",
				issuer: "uptime.test",
			})
		}).pipe(Effect.scoped),
	)
})
