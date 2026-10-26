import { Clock, Context, Duration, Effect, Layer, Option, Result, type Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	effectiveAssertions,
	firstFailedAssertion,
	type UptimeHttpConfig,
	uptimeHttpRequest,
} from "@maple/domain/uptime"
import { describeHttpClientError, guardPinned, readTextPrefix } from "@maple/safe-fetch"
import { HostResolver } from "@maple/safe-fetch/dns"
import {
	type CheckTraceContext,
	describeTransportFailure,
	errorCodeOf,
	failed,
	formatSeconds,
	type ProbeOutcome,
	succeeded,
	traceparentOf,
} from "./UptimeProbe"

export type HttpProbeConfig = Schema.Schema.Type<typeof UptimeHttpConfig>

/** Body prefix the assertions see; reading stops (and the body is cancelled) past it. */
export const MAX_ASSERTION_BODY_BYTES = 64 * 1024

const parseUrl = (raw: string): Option.Option<URL> => Option.liftThrowable(() => new URL(raw))()

/** `host:port` with the scheme's default port filled in. */
export const endpointOf = (url: Option.Option<URL>, raw: string): string =>
	Option.match(url, {
		onNone: () => raw,
		onSome: (parsed) =>
			`${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`,
	})

export interface UptimeHttpProbeApi {
	/**
	 * One HTTP check through the SSRF guard: every hop (redirects included, at most 5) is
	 * validated and dialled at the address it resolved to. Any status is a result judged by
	 * the assertions; transport failures become a one-sentence `error`.
	 */
	readonly probe: (config: HttpProbeConfig, trace: CheckTraceContext) => Effect.Effect<ProbeOutcome>
}

export class UptimeHttpProbe extends Context.Service<UptimeHttpProbe, UptimeHttpProbeApi>()(
	"@maple/scraper/UptimeHttpProbe",
	{
		make: Effect.gen(function* () {
			// Every header is user config: a cross-origin redirect drops them all and the body.
			const client = guardPinned(yield* HttpClient.HttpClient, yield* HostResolver, {
				strictRedirects: true,
			})

			// The shared request shaping (the test endpoint sends the same), plus our traceparent.
			const buildRequest = (config: HttpProbeConfig, trace: CheckTraceContext) => {
				const outgoing = uptimeHttpRequest(config, { traceparent: traceparentOf(trace) })
				const request = HttpClientRequest.make(outgoing.method)(outgoing.url, {
					headers: outgoing.headers,
				})
				return outgoing.body === null
					? request
					: HttpClientRequest.bodyText(request, outgoing.body.text, outgoing.body.contentType)
			}

			const probe = (config: HttpProbeConfig, trace: CheckTraceContext) =>
				Effect.gen(function* () {
					const url = parseUrl(config.url)
					const endpoint = endpointOf(url, config.url)
					const startedAt = yield* Clock.currentTimeMillis
					const result = yield* client.execute(buildRequest(config, trace)).pipe(
						Effect.flatMap((response) =>
							Effect.map(
								config.method === "HEAD"
									? Effect.succeed(null)
									: Effect.map(
											readTextPrefix(response, MAX_ASSERTION_BODY_BYTES),
											(prefix) => prefix.text,
										),
								(body) => ({ response, body }),
							),
						),
						Effect.timeout(Duration.millis(config.timeoutMs)),
						Effect.result,
					)
					const durationMs = (yield* Clock.currentTimeMillis) - startedAt

					if (Result.isFailure(result)) {
						const error = result.failure
						switch (error._tag) {
							case "TimeoutError":
								return failed(
									durationMs,
									"timeout",
									`Connection timed out after ${formatSeconds(config.timeoutMs)}`,
								)
							case "@maple/safe-fetch/HostResolutionError":
								return failed(durationMs, "dns", `Couldn't resolve ${error.hostname}`)
							case "@maple/safe-fetch/UrlValidationError":
								return error.message.startsWith("Too many redirects")
									? failed(durationMs, "transport", error.message)
									: failed(
											durationMs,
											"ssrf_refused",
											`Refused to connect: ${error.message}`,
										)
							case "HttpClientError": {
								const failure = describeTransportFailure(
									endpoint,
									errorCodeOf(error.reason.cause),
									describeHttpClientError(error),
								)
								return failed(durationMs, failure.errorType, failure.error)
							}
						}
					}

					const { response, body } = result.success
					const failure = firstFailedAssertion(effectiveAssertions(config.assertions), {
						statusCode: response.status,
						durationMs,
						headers: { ...response.headers },
						body,
					})
					return failure === null
						? succeeded(durationMs, response.status)
						: failed(durationMs, "assertion", failure, response.status)
				})

			return { probe } satisfies UptimeHttpProbeApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
