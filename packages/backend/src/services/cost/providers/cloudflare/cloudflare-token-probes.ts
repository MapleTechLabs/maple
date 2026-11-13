// Whether a Cloudflare token can do more than read billing. A token cannot be asked what it may
// do (that needs the "API Tokens Read" permission), so a few things a billing token must not see
// are asked for instead. A token with some other extra permission none of them touches passes.
import { Effect, Redacted, Schema, Array as Arr } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { BASE_URL, CloudflareBillingError } from "./cloudflare-billing-api"

interface Probe {
	/** What the token can read when the probe hits, as the refusal names it. */
	readonly finds: string
	readonly path: (accountId: string) => string
	/**
	 * `status`: a 200 is access, whatever the account holds. `list`: a billing token is answered
	 * 200 with an empty list here, so only a list with something in it is access.
	 */
	readonly kind: "status" | "list"
}

const account = (accountId: string) => `/accounts/${encodeURIComponent(accountId)}`

const PROBES: ReadonlyArray<Probe> = [
	{ finds: "account members", kind: "status", path: (id) => `${account(id)}/members?per_page=1` },
	{ finds: "Workers scripts", kind: "status", path: (id) => `${account(id)}/workers/subdomain` },
	{ finds: "audit logs", kind: "status", path: (id) => `${account(id)}/audit_logs?per_page=1` },
	{ finds: "zones", kind: "list", path: () => "/zones?per_page=1" },
	{ finds: "Workers scripts", kind: "list", path: (id) => `${account(id)}/workers/scripts` },
]

const Listing = Schema.Struct({ result: Schema.Array(Schema.Unknown) })

const unanswered = (probe: Probe, what: string, status?: number) =>
	new CloudflareBillingError({
		message: `Cloudflare ${what} when asked for ${probe.finds}`,
		kind: "upstream",
		...(status === undefined ? undefined : { status }),
	})

/** Whether the token reads what the probe asks for. A refusal is the answer wanted, not a failure. */
const hits = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	accountId: string,
	probe: Probe,
): Effect.Effect<boolean, CloudflareBillingError> =>
	Effect.gen(function* () {
		const response = yield* httpClient.execute(
			HttpClientRequest.bearerToken(
				HttpClientRequest.get(`${BASE_URL}${probe.path(accountId)}`),
				token,
			),
		)
		if (response.status === 401 || response.status === 403) return false
		// Neither access nor a refusal: passing the token on it would be a guess.
		if (response.status !== 200)
			return yield* unanswered(probe, `answered ${response.status}`, response.status)
		if (probe.kind === "status") return true
		const body = yield* response.json
		const listing = yield* Schema.decodeUnknownEffect(Listing)(body)
		return listing.result.length > 0
	}).pipe(
		Effect.catchTags({
			HttpClientError: () => Effect.fail(unanswered(probe, "did not answer")),
			SchemaError: () => Effect.fail(unanswered(probe, "answered with a body Maple cannot read")),
		}),
		// A redirect is not Cloudflare answering, so the token is never followed to another host.
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.annotateSpans("peer.service", "cloudflare"),
	)

/**
 * What the token can read beyond billing, by the probes that hit; none for a billing-only token.
 * The probes run side by side: they are five small requests and the save waits for them.
 */
export const readsBeyondBilling = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	accountId: string,
): Effect.Effect<ReadonlyArray<string>, CloudflareBillingError> =>
	Effect.forEach(
		PROBES,
		(probe) => Effect.map(hits(httpClient, token, accountId, probe), (hit) => (hit ? [probe.finds] : [])),
		{ concurrency: "unbounded" },
	).pipe(
		Effect.map((found) => Arr.dedupe(Arr.flatten(found))),
		Effect.tap((found) =>
			Effect.annotateCurrentSpan("maple.cost.cloudflare.excess_probes", found.length),
		),
	)
