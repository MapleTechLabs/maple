import { Array as Arr, Context, Duration, Effect, Layer, Option, Schema, String as Str } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

export class DnsLookupError extends Schema.TaggedError<DnsLookupError>()(
	"@maple/backend/platform/DnsLookupError",
	{ recordName: Schema.String, message: Schema.String },
) {}

const DohAnswer = Schema.Struct({
	Status: Schema.Number,
	Answer: Schema.optionalKey(Schema.Array(Schema.Struct({ type: Schema.Number, data: Schema.String }))),
})

const TXT = 16
const TXT_STRING = /"((?:[^"\\]|\\.)*)"/g
/** NOERROR and NXDOMAIN are answers; anything else (SERVFAIL, REFUSED) is a failed lookup. */
const NXDOMAIN = 3

/** A TXT record's character-strings joined, with the presentation quotes removed. */
export const txtValue = (data: string): string => {
	const parts = Option.getOrElse(Str.match(TXT_STRING)(data), (): ReadonlyArray<string> => [data])
	return Arr.join(
		Arr.map(parts, (part) => Str.replaceAll('\\"', '"')(Str.replace(/^"|"$/g, "")(part))),
		"",
	)
}

export interface DnsTxtResolverApi {
	/** Every TXT value at `name`; empty when the name has none or does not exist. */
	readonly lookupTxt: (name: string) => Effect.Effect<ReadonlyArray<string>, DnsLookupError>
}

/** DNS over HTTPS against Cloudflare's resolver: Workers have no raw DNS, and it works in both regions. */
const make = Effect.gen(function* () {
	const httpClient = yield* HttpClient.HttpClient
	const lookupTxt = Effect.fn("DnsTxtResolver.lookupTxt")(function* (name: string) {
		yield* Effect.annotateCurrentSpan({ "dns.question.name": name })
		const fail = (message: string) => new DnsLookupError({ recordName: name, message })
		const response = yield* httpClient
			.execute(
				HttpClientRequest.get("https://cloudflare-dns.com/dns-query").pipe(
					HttpClientRequest.setUrlParams({ name, type: "TXT" }),
					HttpClientRequest.setHeader("accept", "application/dns-json"),
				),
			)
			.pipe(
				Effect.mapError((error) => fail(error.message)),
				Effect.timeoutOrElse({
					duration: Duration.seconds(5),
					orElse: () => Effect.fail(fail("DNS lookup timed out")),
				}),
				// Client-kind so the service map draws the DoH resolver as a dependency.
				Effect.withSpan("DNS-over-HTTPS TXT", {
					kind: "client",
					attributes: { "peer.service": "cloudflare-dns", "dns.question.name": name },
				}),
			)
		if (response.status !== 200) return yield* fail(`DNS resolver answered ${response.status}`)
		const body = yield* response.json.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(DohAnswer)),
			Effect.mapError(() => fail("DNS resolver answered in an unexpected shape")),
			// Headers can arrive promptly with a stalled body: the read gets the same bound.
			Effect.timeoutOrElse({
				duration: Duration.seconds(5),
				orElse: () => Effect.fail(fail("DNS lookup timed out")),
			}),
		)
		if (body.Status === NXDOMAIN) return []
		if (body.Status !== 0) return yield* fail(`DNS lookup failed with status ${body.Status}`)
		return Arr.map(
			Arr.filter(body.Answer ?? [], (a) => a.type === TXT),
			(a) => txtValue(a.data),
		)
	})
	return { lookupTxt } satisfies DnsTxtResolverApi
})

export class DnsTxtResolver extends Context.Service<DnsTxtResolver, DnsTxtResolverApi>()(
	"@maple/backend/platform/DnsTxtResolver",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
