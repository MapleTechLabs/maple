import { randomUUID } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
} from "@maple/domain/http"
import { SearchConsoleSiteId, type SearchConsoleSiteUrl } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { SearchConsoleSites, type SearchConsoleSiteRow } from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Option, Schema, String as Str, Array as Arr, Order } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import {
	type GoogleAccessTokenError,
	type GoogleConnection,
	GoogleOAuthService,
	isGoogleOAuthConfigured,
} from "@maple/backend/services/auth/GoogleOAuthService"
import { listSites } from "./google-search-console/client"

// The org's Search Console property selection under its Google grant. The daily importer reads
// the enabled rows of `search_console_sites`; this service only writes the selection.

const decodeSiteId = Schema.decodeUnknownSync(SearchConsoleSiteId)

/** Google lists unverified properties too, but answers 403 for their data. */
const UNVERIFIED_PERMISSION = "siteUnverifiedUser"

/** One property the connected Google account can see, merged with the org's saved choice. */
export interface SearchConsoleSiteChoice {
	readonly siteUrl: string
	readonly permissionLevel: string
	/** False for unverified properties, which have no data to read. */
	readonly selectable: boolean
	readonly enabled: boolean
}

export interface SearchConsoleStatus {
	/** False when this deployment has no Google OAuth client. */
	readonly configured: boolean
	readonly connection: GoogleConnection | null
	readonly sites: ReadonlyArray<SearchConsoleSiteRow>
}

export interface SearchConsoleServiceApi {
	readonly getStatus: (orgId: OrgId) => Effect.Effect<SearchConsoleStatus, IntegrationsPersistenceError>
	/** The Google account's properties, live from Google, with the org's saved choice. */
	readonly listAvailableSites: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<SearchConsoleSiteChoice>, GoogleAccessTokenError>
	/**
	 * Enable exactly `siteUrls` and disable every other saved property. Each must be a verified
	 * property the Google account can see; disabled rows keep their import state.
	 */
	readonly saveSites: (
		orgId: OrgId,
		siteUrls: ReadonlyArray<SearchConsoleSiteUrl>,
	) => Effect.Effect<ReadonlyArray<SearchConsoleSiteRow>, GoogleAccessTokenError>
}

const bySiteUrl = Order.mapInput(Str.Order, (row: { readonly siteUrl: string }) => row.siteUrl)

export class SearchConsoleService extends Context.Service<SearchConsoleService, SearchConsoleServiceApi>()(
	"@maple/backend/services/SearchConsoleService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const google = yield* GoogleOAuthService
			const httpClient = yield* HttpClient.HttpClient
			const dbExecute = makeDbExecute(
				database,
				"SearchConsoleService",
				makePersistenceErrorMapper(IntegrationsPersistenceError, "Search Console database error"),
			)

			const loadSites = (orgId: OrgId) =>
				dbExecute((db) =>
					db.run(
						PG.from(SearchConsoleSites)
							.select()
							.where(($) => [$.orgId.eq(orgId)]),
					),
				).pipe(Effect.map(Arr.sort(bySiteUrl)))

			const fetchGoogleSites = (orgId: OrgId) =>
				google.withAccessToken(orgId, (accessToken) =>
					listSites(httpClient, accessToken).pipe(
						Effect.catchTag("@maple/backend/integrations/SearchConsoleApiError", (error) =>
							Effect.fail(
								new IntegrationsUpstreamError({
									message: error.message,
									...(error.status === undefined ? undefined : { status: error.status }),
								}),
							),
						),
					),
				)

			const getStatus = Effect.fn("SearchConsoleService.getStatus")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const connection = yield* google.getConnection(orgId)
				return {
					configured: isGoogleOAuthConfigured(env),
					connection,
					sites: connection === null ? [] : yield* loadSites(orgId),
				} satisfies SearchConsoleStatus
			})

			const listAvailableSites = Effect.fn("SearchConsoleService.listAvailableSites")(function* (
				orgId: OrgId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const entries = yield* fetchGoogleSites(orgId)
				const saved = yield* loadSites(orgId)
				return Arr.sort(
					Arr.map(entries, (entry) => ({
						siteUrl: entry.siteUrl,
						permissionLevel: entry.permissionLevel,
						selectable: entry.permissionLevel !== UNVERIFIED_PERMISSION,
						enabled: Arr.some(saved, (row) => row.siteUrl === entry.siteUrl && row.enabled),
					})),
					bySiteUrl,
				) satisfies ReadonlyArray<SearchConsoleSiteChoice>
			})

			const saveSites = Effect.fn("SearchConsoleService.saveSites")(function* (
				orgId: OrgId,
				siteUrls: ReadonlyArray<SearchConsoleSiteUrl>,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.search_console.selected": siteUrls.length })
				const entries = yield* fetchGoogleSites(orgId)
				const selected = yield* Effect.forEach(Arr.dedupe(siteUrls), (siteUrl) => {
					const entry = Arr.findFirst(entries, (candidate) => candidate.siteUrl === siteUrl)
					if (Option.isNone(entry)) {
						return Effect.fail(
							new IntegrationsValidationError({
								message: `The connected Google account cannot see the Search Console property ${siteUrl}`,
							}),
						)
					}
					if (entry.value.permissionLevel === UNVERIFIED_PERMISSION) {
						return Effect.fail(
							new IntegrationsValidationError({
								message: `Verify ${siteUrl} in Search Console before Maple can import it`,
							}),
						)
					}
					return Effect.succeed({ siteUrl, permissionLevel: entry.value.permissionLevel })
				})
				// withAccessToken already proved the grant exists; a concurrent disconnect lands here.
				const connection = yield* google.getConnection(orgId)
				if (connection === null) {
					return yield* new IntegrationsNotConnectedError({
						message: "Google Search Console is not connected for this organization",
					})
				}
				const currentTime = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.run(
								PG.update(SearchConsoleSites)
									.set({ enabled: false, updatedAt: currentTime })
									.where(($) => [$.orgId.eq(orgId), $.enabled.eq(true)]),
							)
							yield* Effect.forEach(
								selected,
								(site) =>
									db.run(
										PG.insertInto(SearchConsoleSites)
											.values({
												id: decodeSiteId(randomUUID()),
												orgId,
												oauthConnectionId: connection.id,
												siteUrl: site.siteUrl,
												permissionLevel: site.permissionLevel,
												enabled: true,
												createdAt: currentTime,
												updatedAt: currentTime,
											})
											.onConflictDoUpdate({
												target: ["orgId", "siteUrl"],
												set: {
													oauthConnectionId: connection.id,
													permissionLevel: site.permissionLevel,
													enabled: true,
													updatedAt: currentTime,
												},
											}),
									),
								{ discard: true },
							)
						}),
					),
				)
				return yield* loadSites(orgId)
			})

			return { getStatus, listAvailableSites, saveSites } satisfies SearchConsoleServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(GoogleOAuthService.layer),
		Layer.provide(FetchHttpClient.layer),
	)
}
