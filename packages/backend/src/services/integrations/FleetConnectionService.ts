/**
 * An org's Fleet server: the API token is checked with the server (its user must hold a global
 * role, which every read Maple makes needs), stored sealed to the org and the server's address,
 * one server per org. Removing it removes the row and with it the poller's state.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { FleetConnections, type FleetConnectionRow } from "@maple/db/tables"
import {
	FleetIntegrationStatus,
	IntegrationsPersistenceError,
	IntegrationsValidationError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { Clock, Context, Duration, Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { randomUUID } from "node:crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { sealSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { fleetTokenSlot } from "@maple/backend/platform/secret-slots"
import { clearDeviceFindings } from "@maple/backend/services/device-security/device-findings-store"
import * as FleetApi from "./fleet/api"

const VALIDATE_TIMEOUT = Duration.seconds(30)

const NO_GLOBAL_ROLE =
	"This token's user has no global role in Fleet, so it cannot read the activity feed or every fleet's policies. Give the API-only user the Observer role."

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Fleet connection persistence failure",
)

const DISCONNECTED = new FleetIntegrationStatus({
	connected: false,
	baseUrl: null,
	organizationName: null,
	apiUserName: null,
	apiUserRole: null,
	serverVersion: null,
	licenseTier: null,
	connectedByUserId: null,
	connectedAt: null,
	authFailed: false,
	lastSyncedAt: null,
	lastError: null,
})

/** The device findings sync's error while it is the latest outcome; the activity feed's comes first. */
const devicesSyncError = (row: FleetConnectionRow): string | null =>
	row.findingsError !== null &&
	row.findingsErrorAt !== null &&
	(row.findingsSyncedAt === null || row.findingsErrorAt > row.findingsSyncedAt)
		? `Devices sync: ${row.findingsError}`
		: null

export const fleetStatusOf = (row: FleetConnectionRow | undefined): FleetIntegrationStatus =>
	row === undefined
		? DISCONNECTED
		: new FleetIntegrationStatus({
				connected: true,
				baseUrl: row.baseUrl,
				organizationName: row.organizationName,
				apiUserName: row.apiUserName,
				apiUserRole: row.apiUserRole,
				serverVersion: row.serverVersion,
				licenseTier: row.licenseTier,
				connectedByUserId: row.connectedByUserId,
				connectedAt: row.createdAt,
				authFailed: row.authFailedAt !== null,
				lastSyncedAt: row.lastSuccessAt,
				lastError: row.lastError ?? devicesSyncError(row),
			})

/** What the connect form shows for a failed check; every Fleet failure is about the entered server or token. */
const toValidationError = (error: FleetApi.FleetApiError) =>
	new IntegrationsValidationError({
		message:
			error.kind === "forbidden"
				? "Fleet refused this token's user. Give the API-only user the Observer role."
				: error.message,
	})

export interface FleetConnectionServiceApi {
	readonly getStatus: (orgId: OrgId) => Effect.Effect<FleetIntegrationStatus, IntegrationsPersistenceError>
	readonly connect: (
		orgId: OrgId,
		userId: UserId,
		input: { readonly url: string; readonly token: string },
	) => Effect.Effect<FleetIntegrationStatus, IntegrationsValidationError | IntegrationsPersistenceError>
	/** False when nothing was connected. */
	readonly disconnect: (orgId: OrgId) => Effect.Effect<boolean, IntegrationsPersistenceError>
}

export class FleetConnectionService extends Context.Service<
	FleetConnectionService,
	FleetConnectionServiceApi
>()("@maple/backend/services/integrations/FleetConnectionService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const httpClient = yield* HttpClient.HttpClient
		const keyring = yield* secretKeyringFromEnv(
			env,
			(message) => new IntegrationsPersistenceError({ message }),
		)
		const dbExecute = makeDbExecute(database, "FleetConnectionService", toPersistenceError)

		const selectRow = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(FleetConnections)
						.select()
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				),
			)

		const getStatus = Effect.fn("FleetConnectionService.getStatus")(function* (orgId: OrgId) {
			const rows = yield* selectRow(orgId)
			return fleetStatusOf(rows[0])
		})

		/** What the server says about itself and the token, once the token proved it can read. */
		const inspect = Effect.fn("FleetConnectionService.inspect")(
			function* (credentials: FleetApi.FleetCredentials) {
				const fleet = yield* FleetApi.fleetClient(httpClient, credentials)
				const { user } = yield* FleetApi.getMe(fleet)
				if (user.global_role === undefined || user.global_role === null) {
					return yield* new IntegrationsValidationError({ message: NO_GLOBAL_ROLE })
				}
				const [version, config] = yield* Effect.all(
					[FleetApi.getVersion(fleet), FleetApi.getConfig(fleet)],
					{
						concurrency: 2,
					},
				)
				return {
					apiUserName: user.name ?? user.email ?? null,
					apiUserRole: user.global_role,
					serverVersion: version.version,
					organizationName: config.org_info?.org_name ?? null,
					licenseTier: config.license?.tier ?? null,
				}
			},
			Effect.tapError((error) =>
				error._tag === "@maple/backend/integrations/FleetApiError"
					? Effect.annotateCurrentSpan("maple.fleet.error_kind", error.kind)
					: Effect.void,
			),
			Effect.catchTag("@maple/backend/integrations/FleetApiError", (error) =>
				Effect.fail(toValidationError(error)),
			),
			Effect.timeoutOrElse({
				duration: VALIDATE_TIMEOUT,
				orElse: () =>
					Effect.fail(
						new IntegrationsValidationError({ message: "Fleet did not answer in time." }),
					),
			}),
		)

		const connect = Effect.fn("FleetConnectionService.connect")(function* (
			orgId: OrgId,
			userId: UserId,
			input: { readonly url: string; readonly token: string },
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const baseUrl = yield* FleetApi.normalizeFleetUrl(input.url).pipe(
				Effect.mapError((error) => new IntegrationsValidationError({ message: error.message })),
			)
			const token = Redacted.make(input.token)
			const server = yield* inspect({ baseUrl, token })
			// Bound to the org and the address: a row pointed at another server no longer opens.
			const sealed = yield* sealSecret(
				keyring,
				fleetTokenSlot,
				{ orgId, baseUrl },
				Redacted.value(token),
				(message) => new IntegrationsPersistenceError({ message }),
			)
			const now = yield* Clock.currentTimeMillis
			const next = {
				baseUrl,
				tokenCiphertext: sealed.ciphertext,
				tokenIv: sealed.iv,
				tokenTag: sealed.tag,
				...server,
				connectedByUserId: userId,
				authFailedAt: null,
				holdUntil: null,
				lastError: null,
				lastErrorAt: null,
				// A new token clears the device sync's failure too, or the page keeps showing it.
				findingsHoldUntil: null,
				findingsError: null,
				findingsErrorAt: null,
				updatedAt: now,
			}
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// Another server is a new connection: nothing read from the old one carries over.
						const replaced = yield* db.run(
							PG.deleteFrom(FleetConnections)
								.where(($) => [$.orgId.eq(orgId), $.baseUrl.neq(baseUrl)])
								.returning("id"),
						)
						yield* Effect.forEach(replaced, (row) =>
							clearDeviceFindings(db, { orgId, source: "fleet", connectionId: row.id }),
						)
						yield* db.run(
							PG.insertInto(FleetConnections)
								.values({ id: randomUUID(), orgId, createdAt: now, ...next })
								.onConflictDoUpdate({ target: ["orgId"], set: next }),
						)
					}),
				),
			)
			return yield* getStatus(orgId)
		})

		const disconnect = Effect.fn("FleetConnectionService.disconnect")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const rows = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// The row first: a sync holding it commits before the findings are cleared.
						const removed = yield* db.run(
							PG.deleteFrom(FleetConnections)
								.where(($) => [$.orgId.eq(orgId)])
								.returning("id"),
						)
						yield* Effect.forEach(removed, (row) =>
							clearDeviceFindings(db, { orgId, source: "fleet", connectionId: row.id }),
						)
						return removed
					}),
				),
			)
			return rows.length > 0
		})

		return { getStatus, connect, disconnect } satisfies FleetConnectionServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
