/**
 * Maple registers its own webhook on every database of a connected PlanetScale organization,
 * so health events and deploy transitions arrive without anyone copying a URL into PlanetScale.
 *
 * PlanetScale generates each webhook's signing secret, so the secret is stored per database
 * (`planetscale_databases.webhook_secret_*`) and the receiver picks it by the payload's database.
 * Registration needs the `write_databases` grant; without it nothing is called and the card asks
 * for a reauthorization.
 */
import { IntegrationsPersistenceError, type OrgId, PlanetScaleWebhookStatus } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	PlanetscaleConnections,
	PlanetscaleDatabases,
	type PlanetScaleConnectionRow,
	type PlanetScaleDatabaseRow,
} from "@maple/db/tables"
import * as PlanetScale from "@distilled.cloud/planetscale"
import { Cause, Clock, Context, Effect, Layer, Redacted, Schema, SchemaGetter } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Env } from "@maple/backend/platform/Env"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { collectPages, decodeConsumed, runPlanetScale, type SdkError } from "./planetscale/api"
import { PLANETSCALE_WEBHOOK_EVENTS } from "./planetscale/webhook-events"

/** PlanetScale caps a database at 5 webhooks; one page always holds them all. */
const WEBHOOK_PAGE_SIZE = 25
const DATABASE_CONCURRENCY = 2
const WEBHOOK_PATH = "/api/integrations/planetscale/webhook/"

/** Deploy requests and keyspaces are Vitess concepts; Postgres databases never send them. */
const eventsFor = (kind: string): ReadonlyArray<string> =>
	kind === "postgresql"
		? PLANETSCALE_WEBHOOK_EVENTS.filter(
				(event) => !event.startsWith("deploy_request.") && event !== "keyspace.storage",
			)
		: PLANETSCALE_WEBHOOK_EVENTS

/** Whether a grant's scopes allow creating webhooks (organization `write_databases`). */
export const grantsWebhookManagement = (scopes: ReadonlyArray<string>): boolean =>
	scopes.some((scope) => scope === "write_databases" || scope.endsWith(":write_databases"))

/** The card's webhook summary, from the grant's scopes and the org's live database rows. */
export const planetScaleWebhookStatus = (
	scopes: ReadonlyArray<string>,
	databases: ReadonlyArray<Pick<PlanetScaleDatabaseRow, "webhookId" | "webhookError">>,
): PlanetScaleWebhookStatus => {
	const registeredDatabases = databases.filter((row) => row.webhookId !== null).length
	const lastError = databases.find((row) => row.webhookError !== null)?.webhookError ?? null
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
	Schema.declare((value): value is Redacted.Redacted<string> => Redacted.isRedacted(value)).pipe(
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
	/** Delete the webhooks Maple registered for a connection that is going away. Best effort. */
	readonly removeAll: (connection: PlanetScaleConnectionRow) => Effect.Effect<void>
	/** The signing secret of the webhook Maple registered on `databaseName`, or null. */
	readonly secretFor: (
		orgId: OrgId,
		databaseName: string,
	) => Effect.Effect<string | null, IntegrationsPersistenceError>
}

const toPersistenceError = (error: unknown) =>
	new IntegrationsPersistenceError({
		message: error instanceof Error ? error.message : "PlanetScale webhook persistence failed",
	})

const sameEvents = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
	left.length === right.length && left.every((event) => right.includes(event))

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
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new IntegrationsPersistenceError({ message }),
		)
		const webhookBase = `${env.MAPLE_API_BASE_URL.replace(/\/$/, "")}${WEBHOOK_PATH}`
		const webhookUrl = (connection: PlanetScaleConnectionRow) => `${webhookBase}${connection.id}`

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
			return yield* decryptAes256Gcm(
				{
					ciphertext: row.webhookSecretCiphertext,
					iv: row.webhookSecretIv,
					tag: row.webhookSecretTag,
				},
				encryptionKey,
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
			const liveIds = new Set(live.map((row) => row.id))
			return new Set(ids.filter((id) => !liveIds.has(id)))
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
			const ours = webhooks.filter((hook) => hook.url === url)
			const retired = yield* retiredConnectionIds(
				webhooks.flatMap((hook) =>
					hook.url.startsWith(webhookBase) && hook.url !== url
						? [hook.url.slice(webhookBase.length)]
						: [],
				),
			)
			const stale = [
				...ours.slice(1),
				...webhooks.filter((hook) => retired.has(hook.url.slice(webhookBase.length))),
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
				const encrypted = yield* encryptAes256Gcm(
					webhook.secret,
					encryptionKey,
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
			if (!webhookBase.startsWith("https://")) return yield* skip("not_https")
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
										const error = summarizeCause(cause).slice(0, 500)
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
			const registered = outcomes.filter(Boolean).length
			const failed = outcomes.length - registered
			yield* Effect.annotateCurrentSpan({
				"maple.planetscale.webhook.registered": registered,
				"maple.planetscale.webhook.failed": failed,
			})
			return { skipped: null, registered, failed }
		})

		const removeAll = Effect.fn("PlanetScaleWebhookService.removeAll")(
			function* (connection: PlanetScaleConnectionRow) {
				yield* Effect.annotateCurrentSpan({ orgId: connection.orgId })
				const rows = yield* liveDatabases(connection.orgId)
				const grant = yield* psOAuth.grantStatus(connection.orgId)
				const canDelete = grant.revokedAt === null && grantsWebhookManagement(grant.scopes)
				yield* Effect.forEach(
					rows.filter((row) => row.webhookId !== null),
					(row) =>
						Effect.gen(function* () {
							if (canDelete && row.webhookId !== null) {
								yield* callApi(
									connection,
									`deleting the webhook of ${connection.psOrganization}/${row.name}`,
									PlanetScale.deleteWebhook({
										organization: connection.psOrganization,
										database: row.name,
										id: row.webhookId,
									}),
								)
							}
							yield* updateDatabase(row, {
								webhookId: null,
								webhookSecretCiphertext: null,
								webhookSecretIv: null,
								webhookSecretTag: null,
								webhookError: null,
							})
						}).pipe(
							// The connection is going away regardless; a webhook left behind only 404s.
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.logWarning("PlanetScale webhook removal failed").pipe(
											Effect.annotateLogs({
												orgId: connection.orgId,
												database: row.name,
												error: summarizeCause(cause),
											}),
										),
							),
						),
					{ concurrency: DATABASE_CONCURRENCY, discard: true },
				)
			},
			Effect.catchTag("@maple/http/errors/IntegrationsPersistenceError", (error) =>
				Effect.logWarning("PlanetScale webhook removal could not read the inventory").pipe(
					Effect.annotateLogs({ error: error.message }),
				),
			),
		)

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

		return { reconcile, removeAll, secretFor } satisfies PlanetScaleWebhookServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(PlanetScaleOAuthService.layer),
	)
}
