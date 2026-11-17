import { createHmac, timingSafeEqual } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AwsConnections } from "@maple/db/tables"
import { IntegrationsPersistenceError } from "@maple/domain/http"
import { AwsConnectionId, type OrgId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { ingestKeyLookupHmacKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { CloudSecurityStore } from "./CloudSecurityStore"
import { findingEvent } from "./eventbridge-findings"

// Finding events EventBridge delivers from a connection's account, through the API destination
// the setup deploys in each region. The delivery carries the connection's events key; its findings
// are stored as the poller stores them, and the poller still reconciles anything an event missed.

/** The header the setup's EventBridge connection sends the key in. */
export const AWS_EVENTS_KEY_HEADER = "x-maple-events-key"

const EVENTS_KEY_PREFIX = "maple_awsev_"

/** Why a delivery was refused. `bad_key` and `unknown_connection` are never retried by AWS. */
export class CloudSecurityEventRejected extends Schema.TaggedError<CloudSecurityEventRejected>()(
	"@maple/backend/cloud-security/CloudSecurityEventRejected",
	{
		message: Schema.String,
		reason: Schema.Literals(["unknown_connection", "bad_key", "malformed"]),
	},
) {}

/** What a delivery did: `ignored` is acknowledged so AWS does not retry it. */
export interface CloudSecurityEventReceipt {
	readonly outcome: "stored" | "ignored"
	readonly reason: string | null
	readonly orgId: OrgId | null
	readonly findings: number
	readonly skipped: number
}

export interface CloudSecurityEventsServiceApi {
	/** The key a connection's EventBridge connection sends; the setup hands it to the stack. */
	readonly eventsKey: (connectionId: AwsConnectionId) => Effect.Effect<string, IntegrationsPersistenceError>
	readonly receive: (
		rawConnectionId: string,
		presentedKey: string | undefined,
		body: string,
	) => Effect.Effect<CloudSecurityEventReceipt, CloudSecurityEventRejected | IntegrationsPersistenceError>
}

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Cloud security events are unavailable",
)

const decodeConnectionId = Schema.decodeUnknownOption(AwsConnectionId)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const sameKey = (presented: string, expected: string) => {
	const a = Buffer.from(presented, "utf8")
	const b = Buffer.from(expected, "utf8")
	// `timingSafeEqual` throws on a length mismatch; the length of a derived key is not a secret.
	return a.length === b.length && timingSafeEqual(a, b)
}

const ignored = (reason: string, orgId: OrgId | null = null): CloudSecurityEventReceipt => ({
	outcome: "ignored",
	reason,
	orgId,
	findings: 0,
	skipped: 0,
})

export class CloudSecurityEventsService extends Context.Service<
	CloudSecurityEventsService,
	CloudSecurityEventsServiceApi
>()("@maple/backend/services/CloudSecurityEventsService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const database = yield* Database
		const store = yield* CloudSecurityStore
		const featureFlags = yield* OrganizationFeatureFlagsService
		const dbExecute = makeDbExecute(database, "CloudSecurityEventsService", toPersistenceError)
		const persistence = (message: string) => new IntegrationsPersistenceError({ message })

		/**
		 * Derived from the connection id with the lookup HMAC key, so nothing is stored: deleting the
		 * connection is what revokes it.
		 */
		const eventsKey = (connectionId: AwsConnectionId) =>
			Effect.map(
				ingestKeyLookupHmacKey(env, persistence),
				(hmacKey) =>
					`${EVENTS_KEY_PREFIX}${createHmac("sha256", hmacKey).update(`aws-security-events/v1:${connectionId}`, "utf8").digest("base64url")}`,
			)

		const receive = Effect.fn("CloudSecurityEventsService.receive")(function* (
			rawConnectionId: string,
			presentedKey: string | undefined,
			body: string,
		) {
			const connectionId = decodeConnectionId(rawConnectionId)
			if (Option.isNone(connectionId)) {
				return yield* new CloudSecurityEventRejected({
					message: "Unknown events endpoint",
					reason: "unknown_connection",
				})
			}
			yield* Effect.annotateCurrentSpan("maple.aws.connection_id", connectionId.value)
			// The key is checked before anything is read, so a stranger costs no database round trip.
			const expected = yield* eventsKey(connectionId.value)
			if (presentedKey === undefined || !sameKey(presentedKey, expected)) {
				return yield* new CloudSecurityEventRejected({
					message: "Invalid events key",
					reason: "bad_key",
				})
			}
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(AwsConnections)
						.select(($) => ({ orgId: $.orgId, accountId: $.accountId, modules: $.modules }))
						.where(($) => [$.id.eq(connectionId.value)])
						.limit(1),
				),
			)
			const row = rows[0]
			if (row === undefined) {
				return yield* new CloudSecurityEventRejected({
					message: "Unknown events endpoint",
					reason: "unknown_connection",
				})
			}
			yield* Effect.annotateCurrentSpan("orgId", row.orgId)
			// A stack left deployed after the module or the rollout was turned off: acknowledged, not kept.
			if (!Arr.contains(row.modules, "security")) return ignored("module_off", row.orgId)
			if (!(yield* featureFlags.flags(row.orgId)).cloudSecurity)
				return ignored("rollout_off", row.orgId)
			const json = decodeJson(body)
			if (Option.isNone(json)) {
				return yield* new CloudSecurityEventRejected({
					message: "Malformed event",
					reason: "malformed",
				})
			}
			const event = findingEvent(row.accountId, json.value)
			if (Option.isNone(event)) return ignored("not_a_finding_event", row.orgId)
			const { source, region, findings, skipped } = event.value
			yield* Effect.annotateCurrentSpan({
				"maple.cloud_security.source": source,
				"maple.aws.region": region,
				"maple.cloud_security.findings": findings.length,
				"maple.cloud_security.skipped": skipped,
			})
			const syncedAt = yield* Clock.currentTimeMillis
			yield* store.upsertFindings(
				Arr.map(findings, (finding) => ({
					...finding,
					orgId: row.orgId,
					connectionId: connectionId.value,
					accountId: row.accountId,
					region,
					source,
				})),
				syncedAt,
			)
			return {
				outcome: "stored",
				reason: null,
				orgId: row.orgId,
				findings: findings.length,
				skipped,
			} satisfies CloudSecurityEventReceipt
		})

		return { eventsKey, receive } satisfies CloudSecurityEventsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide([CloudSecurityStore.layer, OrganizationFeatureFlagsService.layer]),
	)
}
