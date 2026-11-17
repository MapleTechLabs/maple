import {
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Ref,
	Result,
	type Schema,
	String as Str,
	Array as Arr,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	effectiveAssertions,
	firstFailedAssertion,
	type UptimeAssertion,
	type UptimeCertificate,
	type UptimeCheckRequest,
	type UptimeHttpConfig,
	type UptimeHttpObservation,
	uptimeHttpRequest,
} from "@maple/domain/uptime"
import { describeHttpClientError, guardPinned, readTextPrefix, type ResolveHost } from "@maple/safe-fetch"
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
import {
	addPhases,
	CertificateRecorder,
	hasPhases,
	NO_PHASES,
	PhaseRecorder,
	recordPhases,
} from "./UptimePhases"

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
	/**
	 * One request through the same guard and timing, judged by `assertions`, with what came back
	 * for a caller that reads more of it (a multi-step check's extractions). The body is read when
	 * an assertion needs it or `readBody` asks; the observation is null when no response arrived.
	 */
	readonly request: (
		outgoing: UptimeCheckRequest,
		options: {
			readonly assertions: ReadonlyArray<UptimeAssertion>
			readonly readBody: boolean
			readonly timeoutMs: number
		},
	) => Effect.Effect<RequestResult>
}

export interface RequestResult {
	readonly outcome: ProbeOutcome
	readonly observation: UptimeHttpObservation | null
}

/** An assertion a body prefix cannot settle: anything but a `contains` already found in it. */
const needsUnreadBody = (assertion: UptimeAssertion, prefix: string | null): boolean =>
	assertion._tag === "json_path" ||
	(assertion._tag === "body" &&
		(assertion.op === "not_contains" || prefix === null || !Str.includes(assertion.value)(prefix)))

export class UptimeHttpProbe extends Context.Service<UptimeHttpProbe, UptimeHttpProbeApi>()(
	"@maple/scraper/UptimeHttpProbe",
	{
		make: Effect.gen(function* () {
			const resolveHost = yield* HostResolver
			// Each hop's lookup is the check's DNS phase; the transport reports the rest.
			const resolve: ResolveHost = (hostname) =>
				Effect.timed(resolveHost(hostname)).pipe(
					Effect.flatMap(([took, addresses]) =>
						Effect.as(recordPhases({ dnsMs: Duration.toMillis(took) }), addresses),
					),
				)
			// Scoped, so an unread body is cancelled when the check ends. A cross-origin redirect
			// drops the configured headers and the body, keeping only the headers the probe owns.
			const httpClient = yield* HttpClient.HttpClient
			const client = guardPinned(HttpClient.withScope(httpClient), resolve, {
				strictRedirects: true,
				ownHeaders: ["traceparent", "user-agent"],
			})

			const buildRequest = (outgoing: UptimeCheckRequest) => {
				const request = HttpClientRequest.make(outgoing.method)(outgoing.url, {
					headers: outgoing.headers,
				})
				return outgoing.body === null
					? request
					: HttpClientRequest.bodyText(request, outgoing.body.text, outgoing.body.contentType)
			}

			const check = (
				outgoing: UptimeCheckRequest,
				assertions: ReadonlyArray<UptimeAssertion>,
				readBody: boolean,
				timeoutMs: number,
			): Effect.Effect<RequestResult> =>
				Effect.gen(function* () {
					const endpoint = endpointOf(parseUrl(outgoing.url), outgoing.url)
					// The body is read only when an assertion (or the caller) looks at it, and never for HEAD.
					const readsBody =
						outgoing.method !== "HEAD" &&
						(readBody ||
							Arr.some(
								assertions,
								(assertion) => assertion._tag === "body" || assertion._tag === "json_path",
							))
					const startedAt = yield* Clock.currentTimeMillis
					const result = yield* client.execute(buildRequest(outgoing)).pipe(
						Effect.flatMap((response) =>
							Effect.gen(function* () {
								// Latency is time to the response headers, not the body read after them.
								const respondedInMs = (yield* Clock.currentTimeMillis) - startedAt
								const read = readsBody
									? yield* Effect.timed(
											readTextPrefix(response, MAX_ASSERTION_BODY_BYTES),
										).pipe(
											Effect.flatMap(([took, prefix]) =>
												Effect.as(
													recordPhases({ transferMs: Duration.toMillis(took) }),
													prefix,
												),
											),
										)
									: null
								return {
									response,
									body: read === null ? null : read.text,
									isTruncated: read !== null && read.truncated,
									respondedInMs,
								}
							}),
						),
						Effect.timeout(Duration.millis(timeoutMs)),
						Effect.scoped,
						Effect.result,
					)
					const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt

					if (Result.isFailure(result)) {
						const error = result.failure
						const transport = (outcome: ProbeOutcome): RequestResult => ({
							outcome,
							observation: null,
						})
						switch (error._tag) {
							case "TimeoutError":
								return transport(
									failed(
										elapsedMs,
										"timeout",
										`Connection timed out after ${formatSeconds(timeoutMs)}`,
									),
								)
							case "@maple/safe-fetch/HostResolutionError":
								return transport(
									failed(elapsedMs, "dns", `Couldn't resolve ${error.hostname}`),
								)
							case "@maple/safe-fetch/UrlValidationError":
								return transport(
									Str.startsWith("Too many redirects")(error.message)
										? failed(elapsedMs, "transport", error.message)
										: failed(
												elapsedMs,
												"ssrf_refused",
												`Refused to connect: ${error.message}`,
											),
								)
							case "HttpClientError": {
								const failure = describeTransportFailure(
									endpoint,
									errorCodeOf(error.reason.cause),
									describeHttpClientError(error),
								)
								return transport(failed(elapsedMs, failure.errorType, failure.error))
							}
						}
					}

					const { response, body, isTruncated, respondedInMs: durationMs } = result.success
					// Past the read budget only a `contains` found in the prefix is a sure verdict; the
					// assertions it can settle (status first) still report their own failure.
					const unsettled = isTruncated
						? Arr.filter(assertions, (assertion) => needsUnreadBody(assertion, body))
						: []
					const observation: UptimeHttpObservation = {
						statusCode: response.status,
						durationMs,
						headers: { ...response.headers },
						body,
					}
					const failure =
						firstFailedAssertion(
							Arr.filter(assertions, (assertion) => !unsettled.includes(assertion)),
							observation,
						) ??
						(unsettled.length > 0
							? `Response body is over ${MAX_ASSERTION_BODY_BYTES / 1024} KB, more than body checks read`
							: null)
					return {
						outcome:
							failure === null
								? succeeded(durationMs, response.status)
								: failed(durationMs, "assertion", failure, response.status),
						observation,
					}
				})

			/** `run` with the phases and the first TLS hop's certificate of its requests folded onto its outcome. */
			const measured = (url: string, run: Effect.Effect<RequestResult>): Effect.Effect<RequestResult> =>
				Effect.gen(function* () {
					const phases = yield* Ref.make(NO_PHASES)
					// The first TLS hop's result, an unreadable (null) one included.
					const certificate = yield* Ref.make<Option.Option<UptimeCertificate | null>>(
						Option.none(),
					)
					const { outcome, observation } = yield* run.pipe(
						Effect.provideService(PhaseRecorder, (hop) =>
							Ref.update(phases, (total) => addPhases(total, hop)),
						),
						// The first hop's, so only for an https:// URL: a redirect's host does not stand in for it.
						Effect.provideService(CertificateRecorder, (seen) =>
							Str.startsWith("https:")(Str.toLowerCase(Str.trim(url)))
								? Ref.update(certificate, (first) =>
										Option.isSome(first) ? first : Option.some(seen),
									)
								: Effect.void,
						),
					)
					// The phases that completed, a failed check's too (DNS and connect before a TLS error).
					const timings = yield* Ref.get(phases)
					const firstHop = yield* Ref.get(certificate)
					const presented = Option.getOrNull(Option.flatMapNullishOr(firstHop, (seen) => seen))
					return {
						outcome: {
							...outcome,
							...(hasPhases(timings) ? { timings } : undefined),
							...(presented === null ? undefined : { certificate: presented }),
						},
						observation,
					}
				})

			const probe = (config: HttpProbeConfig, trace: CheckTraceContext) =>
				Effect.map(
					measured(
						config.url,
						check(
							// The shared request shaping (the test endpoint sends the same), plus our traceparent.
							uptimeHttpRequest(config, { traceparent: traceparentOf(trace) }),
							effectiveAssertions(config.assertions),
							false,
							config.timeoutMs,
						),
					),
					(result) => result.outcome,
				)

			const request: UptimeHttpProbeApi["request"] = (outgoing, options) =>
				measured(
					outgoing.url,
					check(outgoing, options.assertions, options.readBody, options.timeoutMs),
				)

			return { probe, request } satisfies UptimeHttpProbeApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
