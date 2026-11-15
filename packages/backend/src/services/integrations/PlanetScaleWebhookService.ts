/**
 * Maple registers its own webhook on every database of a connected PlanetScale organization,
 * so health events and deploy transitions arrive without anyone copying a URL into PlanetScale.
 *
 * PlanetScale generates each webhook's signing secret, so the secret is stored per database
 * (`planetscale_databases.webhook_secret_*`) and the receiver picks it by the payload's database.
 * Registration needs the `write_databases` grant; without it nothing is called and the card asks
 * for a reauthorization.
 */
import {
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	type OrgId,
	PlanetScaleWebhookStatus,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	PlanetscaleConnections,
	PlanetscaleDatabases,
	PlanetscalePollState,
	type PlanetScaleConnectionRow,
	type PlanetScaleDatabaseRow,
} from "@maple/db/tables"
import * as PlanetScale from "@distilled.cloud/planetscale"
import {
	Cause,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
	SchemaGetter,
	Array as Arr,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { openSecret, sealSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { planetScaleDatabaseWebhookSecretSlot } from "@maple/backend/platform/secret-slots"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Env } from "@maple/backend/platform/Env"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { collectPages, decodeConsumed, runPlanetScale, type SdkError } from "./planetscale/api"
import { PLANETSCALE_WEBHOOK_EVENTS } from "./planetscale/webhook-events"
import { makePlanetScalePollState, pollStateResult } from "./planetscale/poll-state"
import { withLease } from "./poller"

/** PlanetScale caps a database at 5 webhooks; one page always holds them all. */
const WEBHOOK_PAGE_SIZE = 25
const DATABASE_CONCURRENCY = 2
const WEBHOOK_PATH = "/api/integrations/planetscale/webhook/"
/** The org-wide poll-state row (`databaseId` "") whose lease every webhook sync runs under. */
export const PLANETSCALE_WEBHOOKS_DATASET = "webhooks"
/** Passes one sync makes while the events switch keeps changing under it. */
const CONVERGE_PASSES = 3
/** A database's `webhookError` while Maple's webhook waits to be deleted at PlanetScale. */
const REMOVAL_PENDING_PREFIX = "Removal pending: "
const REMOVAL_NEEDS_GRANT =
	"the grant cannot delete webhooks; reconnect PlanetScale with write access, or delete it in PlanetScale"

const isNotFound = (error: unknown): boolean =>
	Schema.is(IntegrationsUpstreamError)(error) && error.status === 404

/** Deploy requests and keyspaces are Vitess concepts; Postgres databases never send them. */
const eventsFor = (kind: string): ReadonlyArray<string> =>
	kind === "postgresql"
		? Arr.filter(
				PLANETSCALE_WEBHOOK_EVENTS,
				(event) => !Str.startsWith("deploy_request.")(event) && event !== "keyspace.storage",
			)
		: PLANETSCALE_WEBHOOK_EVENTS

/** Whether a grant's scopes allow creating webhooks (organization `write_databases`). */
const grantsWebhookManagement = (scopes: ReadonlyArray<string>): boolean =>
	Arr.some(scopes, (scope) => scope === "write_databases" || Str.endsWith(":write_databases")(scope))

/** The card's webhook summary, from the grant's scopes and the org's live database rows. */
export const planetScaleWebhookStatus = (
	scopes: ReadonlyArray<string>,
	databases: ReadonlyArray<Pick<PlanetScaleDatabaseRow, "webhookId" | "webhookError">>,
): PlanetScaleWebhookStatus => {
	const registeredDatabases = Arr.filter(databases, (row) => row.webhookId !== null).length
	const lastError = Option.getOrNull(
		Option.flatMapNullishOr(
			Arr.findFirst(databases, (row) => row.webhookError !== null),
			(row) => row.webhookError,
		),
	)
	return new PlanetScaleWebhookStatus({
		state: !grantsWebhookManagement(scopes)
			? "needs_reauthorization"
			: lastError !== null
				? "failing"
				: databases.length > 0 && registeredDatabases === databases.length
					? "active"
					: "pending",
		registeredDatabases,
		databases: databases.length,
		lastError,
	})
}

/** The SDK wraps the signing secret in `Redacted`; a body it passes through unchecked holds a string. */
const SecretSchema = Schema.Union([
	Schema.String,
	Schema.declare((value): value is Redacted.Redacted => Redacted.isRedacted(value)).pipe(
		Schema.decodeTo(Schema.String, {
			decode: SchemaGetter.transform((secret) => String(Redacted.value(secret))),
			encode: SchemaGetter.transform((secret) => Redacted.make(secret)),
		}),
	),
])

const WebhookSchema = Schema.Struct({
	id: Schema.String,
	url: Schema.String,
	secret: Schema.optionalKey(Schema.NullOr(SecretSchema)),
	enabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	events: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
})
type Webhook = Schema.Schema.Type<typeof WebhookSchema>

export type PlanetScaleWebhookSkipReason = "grant_revoked" | "missing_scope" | "not_https"

export interface PlanetScaleWebhookReconcileResult {
	readonly skipped: PlanetScaleWebhookSkipReason | null
	readonly registered: number
	readonly failed: number
}

export interface PlanetScaleWebhookServiceApi {
	/** Make sure every live database has Maple's webhook, and record each database's secret. */
	readonly reconcile: (
		connection: PlanetScaleConnectionRow,
	) => Effect.Effect<PlanetScaleWebhookReconcileResult, IntegrationsPersistenceError>
	/**
	 * Delete the webhooks Maple registered. One that cannot be deleted keeps its id and secret,
	 * marked pending, so deliveries still verify. Returns how many are still pending.
	 */
	readonly removeAll: (connection: PlanetScaleConnectionRow) => Effect.Effect<number>
	/**
	 * Bring the webhooks in line with the stored events switch, under the org's webhooks lease.
	 * False when the row was not claimed (fresh within `freshMs`, or another sync holds it).
	 */
	readonly sync: (orgId: OrgId, freshMs: number) => Effect.Effect<boolean, IntegrationsPersistenceError>
	/** The signing secret of the webhook Maple registered on `databaseName`, or null. */
	readonly secretFor: (
		orgId: OrgId,
		databaseName: string,
	) => Effect.Effect<string | null, IntegrationsPersistenceError>
}

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"PlanetScale webhook persistence failed",
)

const sameEvents = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
	left.length === right.length && Arr.every(left, (event) => right.includes(event))

export class PlanetScaleWebhookService extends Context.Service<
	PlanetScaleWebhookService,
	PlanetScaleWebhookServiceApi
>()("@maple/backend/services/PlanetScaleWebhookService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "PlanetScaleWebhookService", toPersistenceError)
		const env = yield* Env
		const psOAuth = yield* PlanetScaleOAuthService
		const httpClient = yield* HttpClient.HttpClient
		const keyring = yield* secretKeyringFromEnv(
			env,
			(message) => new IntegrationsPersistenceError({ message }),
		)
		const webhookBase = `${Str.replace(/\/$/, "")(env.MAPLE_API_BASE_URL)}${WEBHOOK_PATH}`
		const webhookUrl = (connection: PlanetScaleConnectionRow) => `${webhookBase}${connection.id}`
		const { pollStateLease, unclaimedReason } = makePlanetScalePollState(
			database,
			"PlanetScaleWebhookService",
		)

		/** Clear the row's last success so the next tick's sync claims it whatever the TTL. */
		const markSyncDue = (orgId: OrgId, now: number) =>
			dbExecute((db) =>
				db.run(
					PG.update(PlanetscalePollState)
						.set({ lastSuccessAt: null, updatedAt: now })
						.where(($) => [
							$.orgId.eq(orgId),
							$.dataset.eq(PLANETSCALE_WEBHOOKS_DATASET),
							$.databaseId.eq(""),
						]),
				),
			)

		const callApi = <A, E extends SdkError>(
			connection: PlanetScaleConnectionRow,
			operation: string,
			effect: Effect.Effect<A, E, PlanetScale.PlanetScaleOpContext>,
		) =>
			psOAuth.withAccessToken(connection.orgId, (accessToken) =>
				runPlanetScale(
					httpClient,
					{ apiBaseUrl: env.MAPLE_PLANETSCALE_API_BASE_URL, accessToken },
					operation,
					effect,
				),
			)

		const liveDatabases = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(PlanetscaleDatabases)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.deletedAt.isNull()]),
				),
			)

		const updateDatabase = (
			row: PlanetScaleDatabaseRow,
			values: Partial<
				Pick<
					PlanetScaleDatabaseRow,
					| "webhookId"
					| "webhookSecretCiphertext"
					| "webhookSecretIv"
					| "webhookSecretTag"
					| "webhookError"
				>
			>,
		) =>
			Effect.flatMap(Clock.currentTimeMillis, (now) =>
				dbExecute((db) =>
					db.run(
						PG.update(PlanetscaleDatabases)
							.set({ ...values, updatedAt: now })
							.where(($) => [$.id.eq(row.id)]),
					),
				),
			)

		const storedSecret = Effect.fnUntraced(function* (row: PlanetScaleDatabaseRow) {
			if (
				row.webhookSecretCiphertext === null ||
				row.webhookSecretIv === null ||
				row.webhookSecretTag === null
			) {
				return null
			}
			return yield* openSecret(
				keyring,
				planetScaleDatabaseWebhookSecretSlot,
				{ orgId: row.orgId, id: row.id },
				{
					ciphertext: row.webhookSecretCiphertext,
					iv: row.webhookSecretIv,
					tag: row.webhookSecretTag,
				},
				() =>
					new IntegrationsPersistenceError({
						message: "Failed to decrypt PlanetScale webhook secret",
					}),
			)
		})

		const createWebhook = Effect.fnUntraced(function* (
			connection: PlanetScaleConnectionRow,
			row: PlanetScaleDatabaseRow,
			replacing: Webhook | undefined,
			events: ReadonlyArray<string>,
		) {
			const organization = connection.psOrganization
			if (replacing !== undefined) {
				yield* callApi(
					connection,
					`replacing the webhook of ${organization}/${row.name}`,
					PlanetScale.deleteWebhook({ organization, database: row.name, id: replacing.id }),
				)
			}
			const created = yield* callApi(
				connection,
				`creating the webhook of ${organization}/${row.name}`,
				PlanetScale.createWebhook({
					organization,
					database: row.name,
					url: webhookUrl(connection),
					enabled: true,
					events: [...events],
				}),
			)
			yield* Effect.annotateCurrentSpan("maple.planetscale.webhook.action", "created")
			return yield* decodeConsumed(WebhookSchema, `the new webhook of ${row.name}`)(created)
		})

		/**
		 * Keep an existing webhook delivering: PlanetScale disables one after repeated failed
		 * deliveries, and the event set grows as Maple handles more events.
		 */
		const adoptWebhook = Effect.fnUntraced(function* (
			connection: PlanetScaleConnectionRow,
			row: PlanetScaleDatabaseRow,
			existing: Webhook,
			events: ReadonlyArray<string>,
		) {
			if (existing.enabled !== true || !sameEvents(existing.events ?? [], events)) {
				yield* callApi(
					connection,
					`updating the webhook of ${connection.psOrganization}/${row.name}`,
					PlanetScale.updateWebhook({
						organization: connection.psOrganization,
						database: row.name,
						id: existing.id,
						enabled: true,
						events: [...events],
					}),
				)
			}
			yield* Effect.annotateCurrentSpan("maple.planetscale.webhook.action", "adopted")
			return existing
		})

		/** The ids among `ids` with no connection row left: their webhooks only ever answer 404. */
		const retiredConnectionIds = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
			if (ids.length === 0) return new Set<string>()
			const live = yield* dbExecute((db) =>
				db.run(
					PG.from(PlanetscaleConnections)
						.select("id")
						.where(($) => [$.id.in_(...ids)]),
				),
			)
			const liveIds = new Set(Arr.map(live, (row) => row.id))
			return new Set(Arr.filter(ids, (id) => !liveIds.has(id)))
		})

		/** One database: adopt or create Maple's webhook, delete webhooks of earlier connections. */
		const reconcileDatabase = Effect.fn("PlanetScaleWebhookService.reconcileDatabase")(function* (
			connection: PlanetScaleConnectionRow,
			row: PlanetScaleDatabaseRow,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId: connection.orgId,
				"maple.planetscale.database": row.name,
			})
			const organization = connection.psOrganization
			const url = webhookUrl(connection)
			const events = eventsFor(row.kind)
			const listing = yield* callApi(
				connection,
				`listing webhooks of ${organization}/${row.name}`,
				collectPages(
					PlanetScale.listWebhooks,
					{ organization, database: row.name, per_page: WEBHOOK_PAGE_SIZE },
					1,
				),
			)
			const webhooks = yield* decodeConsumed(
				Schema.Array(WebhookSchema),
				`webhooks of ${row.name}`,
			)(listing.items)

			// Maple's URL more than once, or under a connection id that no longer exists (a reconnect
			// mints a new one). A live id is another Maple org bound to the same PlanetScale org.
			const ours = Arr.filter(webhooks, (hook) => hook.url === url)
			const retired = yield* retiredConnectionIds(
				Arr.flatMap(webhooks, (hook) =>
					Str.startsWith(webhookBase)(hook.url) && hook.url !== url
						? [Str.slice(webhookBase.length)(hook.url)]
						: [],
				),
			)
			const stale = [
				...ours.slice(1),
				...Arr.filter(webhooks, (hook) => retired.has(Str.slice(webhookBase.length)(hook.url))),
			]
			yield* Effect.forEach(
				stale,
				(hook) =>
					callApi(
						connection,
						`deleting a stale webhook of ${organization}/${row.name}`,
						PlanetScale.deleteWebhook({ organization, database: row.name, id: hook.id }),
					),
				{ discard: true },
			)

			const existing = ours[0]
			const stored =
				existing !== undefined && existing.id === row.webhookId ? yield* storedSecret(row) : null
			// No webhook, or one whose secret we cannot learn: only a new one tells us its secret.
			const webhook: Webhook =
				existing === undefined || (existing.secret == null && stored === null)
					? yield* createWebhook(connection, row, existing, events)
					: yield* adoptWebhook(connection, row, existing, events)

			if (webhook.secret != null && (webhook.id !== row.webhookId || webhook.secret !== stored)) {
				const encrypted = yield* sealSecret(
					keyring,
					planetScaleDatabaseWebhookSecretSlot,
					{ orgId: row.orgId, id: row.id },
					webhook.secret,
					() =>
						new IntegrationsPersistenceError({
							message: "Failed to encrypt PlanetScale webhook secret",
						}),
				)
				yield* updateDatabase(row, {
					webhookId: webhook.id,
					webhookSecretCiphertext: encrypted.ciphertext,
					webhookSecretIv: encrypted.iv,
					webhookSecretTag: encrypted.tag,
					webhookError: null,
				})
			} else if (row.webhookError !== null) {
				yield* updateDatabase(row, { webhookError: null })
			}
		})

		const reconcile = Effect.fn("PlanetScaleWebhookService.reconcile")(function* (
			connection: PlanetScaleConnectionRow,
		) {
			yield* Effect.annotateCurrentSpan({ orgId: connection.orgId })
			const skip = (skipped: PlanetScaleWebhookSkipReason) =>
				Effect.annotateCurrentSpan("maple.planetscale.webhook.skip_reason", skipped).pipe(
					Effect.as({ skipped, registered: 0, failed: 0 }),
				)
			// PlanetScale only delivers to public HTTPS endpoints; a local API never gets one.
			if (!Str.startsWith("https://")(webhookBase)) return yield* skip("not_https")
			const grant = yield* psOAuth.grantStatus(connection.orgId)
			if (grant.revokedAt !== null) return yield* skip("grant_revoked")
			if (!grantsWebhookManagement(grant.scopes)) return yield* skip("missing_scope")

			const rows = yield* liveDatabases(connection.orgId)
			const outcomes = yield* Effect.forEach(
				rows,
				(row) =>
					reconcileDatabase(connection, row).pipe(
						Effect.as(true),
						// One database's failure is recorded on its row and must not stop the others.
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.gen(function* () {
										const error = Str.slice(0, 500)(summarizeCause(cause))
										yield* Effect.logWarning(
											"PlanetScale webhook registration failed",
										).pipe(
											Effect.annotateLogs({
												orgId: connection.orgId,
												database: row.name,
												error,
											}),
										)
										if (row.webhookError !== error) {
											yield* updateDatabase(row, { webhookError: error }).pipe(
												Effect.ignore({ log: "Warn" }),
											)
										}
										return false
									}),
						),
					),
				{ concurrency: DATABASE_CONCURRENCY },
			)
			const registered = Arr.filter(outcomes, Boolean).length
			const failed = outcomes.length - registered
			yield* Effect.annotateCurrentSpan({
				"maple.planetscale.webhook.registered": registered,
				"maple.planetscale.webhook.failed": failed,
			})
			return { skipped: null, registered, failed }
		})

		/** Leave the webhook and its secret in place, marked for removal, so a later sync retries. */
		const markRemovalPending = (row: PlanetScaleDatabaseRow, reason: string) => {
			const error = Str.slice(0, 500)(`${REMOVAL_PENDING_PREFIX}${reason}`)
			return row.webhookError === error ? Effect.void : updateDatabase(row, { webhookError: error })
		}

		const removeAll = Effect.fn("PlanetScaleWebhookService.removeAll")(
			function* (connection: PlanetScaleConnectionRow) {
				yield* Effect.annotateCurrentSpan({ orgId: connection.orgId })
				const live = yield* liveDatabases(connection.orgId)
				const rows = Arr.filter(live, (row) => row.webhookId !== null)
				if (rows.length === 0) return 0
				const grant = yield* psOAuth.grantStatus(connection.orgId)
				const canDelete = grant.revokedAt === null && grantsWebhookManagement(grant.scopes)
				const removed = yield* Effect.forEach(
					rows,
					(row) =>
						Effect.gen(function* () {
							// The secret stays so deliveries still verify and are dropped with a 200.
							if (!canDelete || row.webhookId === null) {
								yield* markRemovalPending(row, REMOVAL_NEEDS_GRANT)
								return false
							}
							yield* callApi(
								connection,
								`deleting the webhook of ${connection.psOrganization}/${row.name}`,
								PlanetScale.deleteWebhook({
									organization: connection.psOrganization,
									database: row.name,
									id: row.webhookId,
								}),
							).pipe(
								// Already gone at PlanetScale: the state we wanted.
								Effect.catchIf(isNotFound, () => Effect.void),
							)
							yield* updateDatabase(row, {
								webhookId: null,
								webhookSecretCiphertext: null,
								webhookSecretIv: null,
								webhookSecretTag: null,
								webhookError: null,
							})
							return true
						}).pipe(
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.logWarning("PlanetScale webhook removal failed").pipe(
											Effect.annotateLogs({
												orgId: connection.orgId,
												database: row.name,
												error: summarizeCause(cause),
											}),
											Effect.andThen(
												markRemovalPending(row, summarizeCause(cause)).pipe(
													Effect.ignore({ log: "Warn" }),
												),
											),
											Effect.as(false),
										),
							),
						),
					{ concurrency: DATABASE_CONCURRENCY },
				)
				const pending = Arr.filter(removed, (done) => !done).length
				yield* Effect.annotateCurrentSpan("maple.planetscale.webhook.removal_pending", pending)
				return pending
			},
			Effect.catchTag("@maple/http/errors/IntegrationsPersistenceError", (error) =>
				Effect.logWarning("PlanetScale webhook removal could not read the inventory").pipe(
					Effect.annotateLogs({ error: error.message }),
					Effect.as(1),
				),
			),
		)

		const loadConnectionRow = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(PlanetscaleConnections)
						.select()
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		/** One pass toward the stored events switch; the error is what the poll-state row records. */
		const convergeOnce = Effect.fnUntraced(function* (connection: PlanetScaleConnectionRow) {
			if (!connection.eventsEnabled) {
				const pending = yield* removeAll(connection)
				return pending > 0 ? `${pending} database webhook(s) still to remove` : null
			}
			const result = yield* reconcile(connection)
			// A skip (no write access yet) is not a success: the next tick checks the grant again.
			return result.skipped !== null
				? `Webhook sync skipped: ${result.skipped}`
				: result.failed > 0
					? `${result.failed} database webhook(s) failed to register`
					: null
		})

		const sync = Effect.fn("PlanetScaleWebhookService.sync")(function* (orgId: OrgId, freshMs: number) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const now = yield* Clock.currentTimeMillis
			const outcome = yield* withLease(
				pollStateLease(orgId, PLANETSCALE_WEBHOOKS_DATASET, "", freshMs),
				now,
				(lease) => {
					// The switch is read inside the lease and again after each pass, so a flip made
					// while a pass ran is applied before the lease is let go.
					const pass = (
						applied: boolean | null,
						attempts: number,
					): Effect.Effect<boolean, IntegrationsPersistenceError> =>
						Effect.gen(function* () {
							const connection = yield* loadConnectionRow(orgId)
							if (
								connection === null ||
								connection.eventsEnabled === applied ||
								attempts === 0
							) {
								return connection?.eventsEnabled ?? false
							}
							const error = yield* convergeOnce(connection)
							const finishedAt = yield* Clock.currentTimeMillis
							yield* lease.write(pollStateResult(finishedAt, error))
							return yield* pass(connection.eventsEnabled, attempts - 1)
						})
					return pass(null, CONVERGE_PASSES).pipe(
						Effect.tapError((error) =>
							lease
								.write(pollStateResult(lease.now, error.message))
								.pipe(Effect.ignore({ log: "Warn" })),
						),
					)
				},
			)
			if (Option.isNone(outcome)) {
				const reason = yield* unclaimedReason(orgId, PLANETSCALE_WEBHOOKS_DATASET, "", freshMs, now)
				yield* Effect.annotateCurrentSpan({ "maple.planetscale.skip_reason": reason })
				// Another sync holds the lease: make the next tick due, so it applies the switch.
				if (reason === "lease_held") yield* markSyncDue(orgId, now)
				return false
			}
			yield* Effect.annotateCurrentSpan("maple.planetscale.events_enabled", outcome.value)
			return true
		})

		const secretFor = Effect.fn("PlanetScaleWebhookService.secretFor")(function* (
			orgId: OrgId,
			databaseName: string,
		) {
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(PlanetscaleDatabases)
						.select()
						.where(($) => [
							$.orgId.eq(orgId),
							$.name.eq(databaseName),
							$.deletedAt.isNull(),
							$.webhookSecretCiphertext.isNotNull(),
						])
						.limit(1),
				),
			)
			const row = rows[0]
			return row === undefined ? null : yield* storedSecret(row)
		})

		return { reconcile, removeAll, sync, secretFor } satisfies PlanetScaleWebhookServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(PlanetScaleOAuthService.layer),
	)
}
