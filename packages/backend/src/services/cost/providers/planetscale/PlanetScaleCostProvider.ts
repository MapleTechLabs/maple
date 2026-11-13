/**
 * PlanetScale as a cost provider: an organization's monthly invoices per database and branch,
 * spread over the days each branch existed, read with the OAuth grant of the org's PlanetScale
 * connection.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { PlanetscaleConnections } from "@maple/db/tables"
import {
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Redacted,
	Schema,
	Array as Arr,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import {
	type PlanetScaleAccessTokenError,
	planetScaleBearerHeader,
	PlanetScaleOAuthService,
} from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { PlanetScaleTokenRejectedError } from "../../../integrations/planetscale/api"
import {
	type CostProviderAdapter,
	CostProviderError,
	type CostPull,
	type CostPullSource,
	type CostPullWindow,
} from "../../CostProvider"
import { utcToday } from "../../sync-plan"
import {
	type Invoice,
	listInvoices,
	type PlanetScaleInvoiceApiError,
	type PlanetScaleInvoiceCredentials,
	withinTime,
} from "./invoices-api"
import { readInvoiceCost } from "./pull"

type Reason = CostProviderError["reason"]

/** What a grant made before Maple asked for invoices is told, by the sync and by the Cost page. */
export const RECONNECT_FOR_INVOICES = "Reconnect PlanetScale to grant Maple access to invoices."

const RECONNECT_REVOKED =
	"PlanetScale no longer accepts Maple's authorization. Reconnect PlanetScale to resume the sync."

/** Whether a grant's scopes allow reading invoices (organization `read_invoices`). */
const grantsInvoices = (scopes: ReadonlyArray<string>): boolean =>
	Arr.some(scopes, (scope) => scope === "read_invoices" || Str.endsWith(":read_invoices")(scope))

/**
 * Whether the grant can read invoices, as far as its stored scopes say. A grant PlanetScale
 * reported no scopes for is not ruled out: the read itself then answers.
 */
export const planetScaleCanReadInvoices = (scopes: ReadonlyArray<string>): boolean =>
	scopes.length === 0 || grantsInvoices(scopes)

/**
 * A read of the invoices that failed. `reason` is what the sync does next; `kind` keeps apart what
 * an add has to tell the person adding: no connection, or a grant only a reconnect can fix.
 */
export class PlanetScaleCostReadError extends Schema.TaggedError<PlanetScaleCostReadError>()(
	"@maple/backend/cost/PlanetScaleCostReadError",
	{
		message: Schema.String,
		reason: CostProviderError.fields.reason,
		kind: Schema.Literals(["no_connection", "reconnect", "other"]),
	},
) {}

const failed = (reason: Reason, message: string, kind: PlanetScaleCostReadError["kind"] = "other") =>
	new PlanetScaleCostReadError({ message, reason, kind })

const revoked = () => failed("auth", RECONNECT_REVOKED, "reconnect")

/** How long an add waits for the invoice list before it says so. */
const CHECK_TIMEOUT = Duration.seconds(20)

/**
 * The invoice API refused a fresh access token. That is said of invoices only: the grant is the
 * integration's too, and whether it is dead is for a call the integration relies on to find.
 */
const refusedForInvoices = () =>
	failed(
		"auth",
		"PlanetScale refused Maple's authorization for invoices. Reconnect PlanetScale to grant access to invoices.",
		"reconnect",
	)

/** PlanetScale's answers and the grant's own failures, as what the sync does next and the Cost page shows. */
const toReadError = (
	error: PlanetScaleInvoiceApiError | PlanetScaleAccessTokenError,
): PlanetScaleCostReadError => {
	switch (error._tag) {
		case "@maple/http/errors/IntegrationsNotConnectedError":
			return revoked()
		// The grant was live when the read began: this is the invoice API refusing its fresh token.
		case "@maple/http/errors/IntegrationsRevokedError":
			return refusedForInvoices()
		case "@maple/backend/cost/PlanetScaleInvoiceApiError":
			break
		default:
			return failed("upstream", "Maple could not get a PlanetScale access token.")
	}
	switch (error.reason) {
		case "unauthorized":
			return refusedForInvoices()
		case "forbidden":
			return failed("not_ready", RECONNECT_FOR_INVOICES, "reconnect")
		case "not_found":
			return failed(
				"not_ready",
				"PlanetScale's authorization can no longer see this organization. Reconnect PlanetScale.",
				"reconnect",
			)
		case "rate_limited":
			return failed("rate_limited", "PlanetScale is rate limiting invoice requests.")
		case "invalid_response":
			return failed("invalid_response", "PlanetScale's invoice answer could not be read.")
		case "too_large":
			return failed(
				"too_large",
				"This organization has more invoices or invoice line items than Maple reads.",
			)
		case "timed_out":
			return failed("upstream", "PlanetScale took too long to answer.")
		case "upstream":
			return failed("upstream", "PlanetScale did not answer the invoice request.")
	}
}

export interface PlanetScaleCostProviderApi extends CostProviderAdapter {
	/** `pull`, failing with what an add needs to tell a grant to reconnect from an outage. */
	readonly read: (
		source: CostPullSource,
		window: CostPullWindow,
	) => Effect.Effect<CostPull, PlanetScaleCostReadError>
	/** One page of the invoice list, read as a pull would: proof the grant can, before a source is made. */
	readonly check: (
		source: CostPullSource,
	) => Effect.Effect<ReadonlyArray<Invoice>, PlanetScaleCostReadError>
}

export class PlanetScaleCostProvider extends Context.Service<
	PlanetScaleCostProvider,
	PlanetScaleCostProviderApi
>()("@maple/backend/services/cost/PlanetScaleCostProvider", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const psOAuth = yield* PlanetScaleOAuthService
		const httpClient = yield* HttpClient.HttpClient
		const dbExecute = makeDbExecute(database, "PlanetScaleCostProvider", () =>
			failed("upstream", "PlanetScale connection database error"),
		)

		/**
		 * Runs `use` against the organization of the source's connection, with the org's grant. A
		 * grant known to be revoked or to lack the invoice scope is refused without a request. A 401
		 * goes through the grant's own refresh, once. A fresh token refused too fails the read and
		 * leaves the grant as it is: a cost read never revokes what metrics and webhooks run on.
		 */
		const withGrant = <A>(
			source: CostPullSource,
			use: (credentials: PlanetScaleInvoiceCredentials) => Effect.Effect<A, PlanetScaleInvoiceApiError>,
		): Effect.Effect<A, PlanetScaleCostReadError> =>
			Effect.gen(function* () {
				// By org as well as id: a source never reads through another org's connection.
				const [connection] = yield* dbExecute((db) =>
					db.run(
						PG.from(PlanetscaleConnections)
							.select("id", "psOrganization")
							.where(($) => [$.orgId.eq(source.orgId), $.id.eq(source.connectionRef)])
							.limit(1),
					),
				)
				if (connection === undefined) {
					return yield* failed(
						"auth",
						"No PlanetScale connection is saved for this source.",
						"no_connection",
					)
				}
				const grant = yield* psOAuth
					.grantStatus(source.orgId)
					.pipe(Effect.mapError(() => failed("upstream", "PlanetScale connection database error")))
				if (grant.updatedAt === null || grant.revokedAt !== null) return yield* revoked()
				if (!planetScaleCanReadInvoices(grant.scopes)) {
					return yield* failed("not_ready", RECONNECT_FOR_INVOICES, "reconnect")
				}
				return yield* psOAuth
					.withAccessToken(
						source.orgId,
						(accessToken) =>
							use({
								apiBaseUrl: env.MAPLE_PLANETSCALE_API_BASE_URL,
								organization: connection.psOrganization,
								authorization: Redacted.make(planetScaleBearerHeader(accessToken)),
							}).pipe(
								// The page shows the mapped message; which failure it was stays on the span.
								Effect.tapError((error) =>
									Effect.annotateCurrentSpan({
										"maple.cost.planetscale.error": error.reason,
										"maple.cost.planetscale.status": error.status,
									}),
								),
								// The grant's own refresh keys on this error.
								Effect.mapError((error) =>
									error.reason === "unauthorized"
										? new PlanetScaleTokenRejectedError({ message: error.message })
										: error,
								),
							),
						{ stampRevoked: false },
					)
					.pipe(Effect.mapError(toReadError))
			})

		const annotate = (source: CostPullSource) =>
			Effect.annotateCurrentSpan({ orgId: source.orgId, "maple.cost.provider": "planetscale" })

		/** Which reason a failed read gave, on its span. */
		const tagReason = <A>(read: Effect.Effect<A, PlanetScaleCostReadError>) =>
			Effect.tapError(read, (error) =>
				Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
			)

		const read = Effect.fn("PlanetScaleCostProvider.read")(function* (
			source: CostPullSource,
			window: CostPullWindow,
		) {
			yield* annotate(source)
			yield* Effect.annotateCurrentSpan({
				"maple.cost.start_day": window.startDay,
				"maple.cost.end_day": window.endDay,
			})
			const now = yield* Clock.currentTimeMillis
			const rows = yield* withGrant(source, (credentials) =>
				readInvoiceCost(httpClient, credentials, window, utcToday(now)),
			)
			yield* Effect.annotateCurrentSpan({ "maple.cost.rows": rows.length })
			return { rows, requests: 0 } satisfies CostPull
		}, tagReason)

		const check = Effect.fn("PlanetScaleCostProvider.check")(function* (source: CostPullSource) {
			yield* annotate(source)
			// Bounded per request: an add must answer, and a token refresh is never cut short.
			return yield* withGrant(source, (credentials) =>
				listInvoices(httpClient, credentials, () => true).pipe(withinTime(CHECK_TIMEOUT)),
			)
		}, tagReason)

		// PlanetScale does not bill for API requests, so no failure counts any.
		const pull = (source: CostPullSource, window: CostPullWindow) =>
			read(source, window).pipe(
				Effect.mapError(
					({ message, reason }) =>
						new CostProviderError({ message, provider: "planetscale", reason, requests: 0 }),
				),
			)

		return { provider: "planetscale", pull, read, check } satisfies PlanetScaleCostProviderApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, PlanetScaleOAuthService.layer)),
	)
}
