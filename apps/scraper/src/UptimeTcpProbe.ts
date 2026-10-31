import { createConnection, isIP } from "node:net"
import { Clock, Context, Duration, Effect, Layer, Result, Schema } from "effect"
import type { UptimeTcpConfig } from "@maple/domain/uptime"
import { isPrivateAddress, parseExternalUrl } from "@maple/safe-fetch"
import { HostResolver } from "@maple/safe-fetch/dns"
import {
	describeTransportFailure,
	errorCodeOf,
	failed,
	formatSeconds,
	type ProbeOutcome,
	succeeded,
} from "./UptimeProbe"

export type TcpProbeConfig = Schema.Schema.Type<typeof UptimeTcpConfig>

export class TcpConnectError extends Schema.TaggedError<TcpConnectError>()("@maple/scraper/TcpConnectError", {
	message: Schema.String,
	code: Schema.NullOr(Schema.String),
}) {}

/** Opens a TCP connection to an already-validated address and closes it at once. */
export type DialTcp = (address: string, port: number) => Effect.Effect<void, TcpConnectError>

/** The socket is destroyed on connect, on error, and on interruption (a timeout). */
export const dialTcp: DialTcp = (address, port) =>
	Effect.callback<void, TcpConnectError>((resume) => {
		const socket = createConnection({ host: address, port })
		socket.once("connect", () => {
			socket.destroy()
			resume(Effect.void)
		})
		socket.once("error", (cause) => {
			socket.destroy()
			resume(Effect.fail(new TcpConnectError({ message: cause.message, code: errorCodeOf(cause) })))
		})
		return Effect.sync(() => socket.destroy())
	})

/** The dialer the TCP probe uses; the real socket unless a test swaps it. */
export const TcpDialer = Context.Reference<DialTcp>("@maple/scraper/TcpDialer", {
	defaultValue: () => dialTcp,
})

class TcpRefused extends Schema.TaggedError<TcpRefused>()("@maple/scraper/TcpRefused", {
	message: Schema.String,
	kind: Schema.Literals(["dns", "ssrf_refused"]),
}) {}

export interface UptimeTcpProbeApi {
	/** Resolve, refuse private and reserved addresses, then connect to the first address with a timeout. */
	readonly probe: (config: TcpProbeConfig) => Effect.Effect<ProbeOutcome>
}

export class UptimeTcpProbe extends Context.Service<UptimeTcpProbe, UptimeTcpProbeApi>()(
	"@maple/scraper/UptimeTcpProbe",
	{
		make: Effect.gen(function* () {
			const resolve = yield* HostResolver
			const dial = yield* TcpDialer

			// The same rules as an HTTP URL: blocked names, private literals, and every resolved answer.
			const addressFor = (configured: string) =>
				Effect.gen(function* () {
					// `[2001:db8::1]` is an IPv6 literal written as a URL host, not a name to resolve.
					const host = /^\[.*\]$/u.test(configured) ? configured.slice(1, -1) : configured
					const refused = new TcpRefused({
						message: `Refused to connect: ${host} is a loopback, private, or reserved address`,
						kind: "ssrf_refused",
					})
					if (isIP(host) !== 0) return isPrivateAddress(host) ? yield* refused : host
					if (Result.isFailure(parseExternalUrl(`http://${host}/`))) return yield* refused
					const addresses = yield* resolve(host).pipe(
						Effect.mapError(
							() => new TcpRefused({ message: `Couldn't resolve ${host}`, kind: "dns" }),
						),
					)
					const first = addresses.find((address) => !address.includes(":")) ?? addresses[0]
					if (first === undefined) {
						return yield* new TcpRefused({ message: `Couldn't resolve ${host}`, kind: "dns" })
					}
					if (addresses.some(isPrivateAddress)) {
						return yield* new TcpRefused({
							message: `Refused to connect: ${host} resolves to a loopback, private, or reserved address`,
							kind: "ssrf_refused",
						})
					}
					return first
				})

			const probe = (config: TcpProbeConfig) =>
				Effect.gen(function* () {
					const endpoint = `${config.host}:${config.port}`
					const startedAt = yield* Clock.currentTimeMillis
					const result = yield* addressFor(config.host).pipe(
						Effect.flatMap((address) => dial(address, config.port)),
						Effect.timeout(Duration.millis(config.timeoutMs)),
						Effect.result,
					)
					const durationMs = (yield* Clock.currentTimeMillis) - startedAt
					if (Result.isSuccess(result)) return succeeded(durationMs)
					const error = result.failure
					switch (error._tag) {
						case "TimeoutError":
							return failed(
								durationMs,
								"timeout",
								`Connection timed out after ${formatSeconds(config.timeoutMs)}`,
							)
						case "@maple/scraper/TcpRefused":
							return failed(durationMs, error.kind, error.message)
						case "@maple/scraper/TcpConnectError": {
							const failure = describeTransportFailure(endpoint, error.code, error.message)
							return failed(durationMs, failure.errorType, failure.error)
						}
					}
				})

			return { probe } satisfies UptimeTcpProbeApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
