/**
 * Where this isolate runs, for the tick spans. A service-binding request carries no `request.cf`,
 * so the placed handler cannot read its colo off the request. Cloudflare's trace endpoint answers
 * with the data center the subrequest left from, which is where the isolate runs.
 */
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

export const TRACE_URL = "https://cloudflare.com/cdn-cgi/trace"
const LOOKUP_TIMEOUT = "1500 millis"

export class ColoLookupError extends Schema.TaggedError<ColoLookupError>()(
	"@maple/alerting/errors/ColoLookupError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** The `colo=` line of a `/cdn-cgi/trace` body, e.g. `IAD`. */
export const parseTraceColo = (body: string): Option.Option<string> =>
	Option.fromNullishOr(/^colo=([A-Z0-9]+)$/m.exec(body)?.[1])

/** One trace request. An isolate never moves, so callers cache the success per isolate. */
export const lookupColo = Effect.fn("alerting.lookup_colo")(
	function* () {
		const response = yield* HttpClient.execute(HttpClientRequest.get(TRACE_URL)).pipe(
			Effect.mapError((cause) => new ColoLookupError({ message: "Trace request failed", cause })),
		)
		const body = yield* response.text.pipe(
			Effect.mapError((cause) => new ColoLookupError({ message: "Trace body unreadable", cause })),
		)
		return yield* Option.match(parseTraceColo(body), {
			onNone: () => Effect.fail(new ColoLookupError({ message: "Trace body has no colo" })),
			onSome: Effect.succeed,
		})
	},
	(effect) =>
		effect.pipe(
			Effect.timeoutOrElse({
				duration: LOOKUP_TIMEOUT,
				orElse: () => Effect.fail(new ColoLookupError({ message: "Trace request timed out" })),
			}),
		),
)

/**
 * Caches the isolate's colo once known. No single-flight: a request awaiting another request's
 * in-flight lookup is resumed in that request's I/O context, and workerd cancels it as hung.
 */
export const isolateColoCache = <R>(lookup: Effect.Effect<string, ColoLookupError, R>) =>
	Effect.sync(() => {
		let known: string | undefined
		return Effect.suspend(() =>
			known === undefined
				? lookup.pipe(
						Effect.tapError((error) => Effect.logWarning("Alerting colo lookup failed", error)),
						// A failed lookup stays "unknown" for the isolate rather than costing every fire a timeout.
						Effect.orElseSucceed(() => "unknown"),
						Effect.tap((colo) =>
							Effect.sync(() => {
								known = colo
							}),
						),
					)
				: Effect.succeed(known),
		)
	})
