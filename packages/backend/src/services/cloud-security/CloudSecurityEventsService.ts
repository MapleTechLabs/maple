import { timingSafeEqual } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AwsConnections } from "@maple/db/tables"
import { IntegrationsPersistenceError } from "@maple/domain/http"
import { type AwsAccountId, AwsConnectionId, type AwsModule, type OrgId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { ingestKeyLookupHmacKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { CloudSecurityStore } from "./CloudSecurityStore"
import { findingEvent } from "./eventbridge-findings"
import { awsEventsKey } from "./events-key"

// Finding events EventBridge delivers from a connection's account, through the API destination
// the setup deploys in each region. The delivery carries the connection's events key; its findings
// are stored as the poller stores them, and the poller still reconciles anything an event missed.

export { AWS_EVENTS_KEY_HEADER } from "./events-key"

/** Why a delivery was refused. `bad_key` and `unknown_connection` are never retried by AWS. */
export class CloudSecurityEventRejected extends Schema.TaggedError<CloudSecurityEventRejected>()(
	"@maple/backend/cloud-security/CloudSecurityEventRejected",
	{
		message: Schema.String,
		reason: Schema.Literals(["unknown_connection", "bad_key", "malformed"]),
	},
) {}

/** The connection a delivery's key was accepted for. */
export interface CloudSecurityEventSender {
	readonly connectionId: AwsConnectionId
	readonly orgId: OrgId
	readonly accountId: AwsAccountId
	readonly modules: ReadonlyArray<AwsModule>
	readonly verifiedAt: number | null
}

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
	/** Whose delivery this is, from its path and key alone: nothing of the body is needed yet. */
	readonly authenticate: (
		rawConnectionId: string,
		presentedKey: string | undefined,
	) => Effect.Effect<CloudSecurityEventSender, CloudSecurityEventRejected | IntegrationsPersistenceError>
	/** Stores what an authenticated delivery's body carries. */
	readonly accept: (
		sender: CloudSecurityEventSender,
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

const ignored = (reason: string, orgId: OrgId): CloudSecurityEventReceipt => ({
	outcome: "ignored",
	reason,
	orgId,
	findings: 0,
	skipped: 0,
})

/** A connection's salt; null for one made before salts, and for one that is gone. */
const saltOf = (row: Option.Option<{ readonly eventsKeySalt: string | null }>) =>
	Option.getOrNull(Option.flatMapNullishOr(row, (found) => found.eventsKeySalt))

const unknownConnection = () =>
	new CloudSecurityEventRejected({ message: "Unknown events endpoint", reason: "unknown_connection" })
const badKey = () => new CloudSecurityEventRejected({ message: "Invalid events key", reason: "bad_key" })

export class CloudSecurityEventsService extends Context.Service<
	CloudSecurityEventsService,
	CloudSecurityEventsServiceApi
>()("@maple/backend/services/CloudSecurityEventsService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const database = yield* Database
		const store = yield* CloudSecurityStore
		const dbExecute = makeDbExecute(database, "CloudSecurityEventsService", toPersistenceError)
		const persistence = (message: string) => new IntegrationsPersistenceError({ message })

		const connectionRow = (connectionId: AwsConnectionId) =>
			Effect.map(
				dbExecute((db) =>
					db.run(
						PG.from(AwsConnections)
							.select(($) => ({
								orgId: $.orgId,
								accountId: $.accountId,
								modules: $.modules,
								verifiedAt: $.verifiedAt,
								eventsKeySalt: $.eventsKeySalt,
							}))
							.where(($) => [$.id.eq(connectionId)])
							.limit(1),
					),
				),
				Arr.head,
			)

		const keyOf = (connectionId: AwsConnectionId, salt: string | null) =>
			Effect.map(ingestKeyLookupHmacKey(env, persistence), (hmacKey) =>
				awsEventsKey(hmacKey, connectionId, salt),
			)

		const eventsKey = (connectionId: AwsConnectionId) =>
			Effect.flatMap(connectionRow(connectionId), (row) => keyOf(connectionId, saltOf(row)))

		const authenticate = Effect.fn("CloudSecurityEventsService.authenticate")(function* (
			rawConnectionId: string,
			presentedKey: string | undefined,
		) {
			const connectionId = decodeConnectionId(rawConnectionId)
			if (Option.isNone(connectionId)) return yield* unknownConnection()
			yield* Effect.annotateCurrentSpan("maple.aws.connection_id", connectionId.value)
			// A delivery without a key costs no database read.
			if (presentedKey === undefined) return yield* badKey()
			const row = yield* connectionRow(connectionId.value)
			// A connection that is gone is checked against the key its id alone gives, so a wrong
			// key learns nothing about which connections exist.
			const expected = yield* keyOf(connectionId.value, saltOf(row))
			if (!sameKey(presentedKey, expected)) return yield* badKey()
			if (Option.isNone(row)) return yield* unknownConnection()
			yield* Effect.annotateCurrentSpan("orgId", row.value.orgId)
			return {
				connectionId: connectionId.value,
				orgId: row.value.orgId,
				accountId: row.value.accountId,
				modules: row.value.modules,
				verifiedAt: row.value.verifiedAt,
			} satisfies CloudSecurityEventSender
		})

		const accept = Effect.fn("CloudSecurityEventsService.accept")(function* (
			sender: CloudSecurityEventSender,
			body: string,
		) {
			const { connectionId, orgId, accountId } = sender
			yield* Effect.annotateCurrentSpan({ "maple.aws.connection_id": connectionId, orgId })
			// A stack left deployed after the module was turned off: acknowledged, not kept. The rollout
			// flag gates the page only; a failed flag read would drop events AWS does not retry.
			if (!Arr.contains(sender.modules, "security")) return ignored("module_off", orgId)
			// Until a check has assumed the role, the account is not known to be the customer's.
			if (sender.verifiedAt === null) return ignored("not_verified", orgId)
			const json = decodeJson(body)
			if (Option.isNone(json)) {
				return yield* new CloudSecurityEventRejected({
					message: "Malformed event",
					reason: "malformed",
				})
			}
			const syncedAt = yield* Clock.currentTimeMillis
			const event = findingEvent(accountId, json.value, syncedAt)
			if (Option.isNone(event)) return ignored("not_a_finding_event", orgId)
			const { source, region, findings, skipped, overCap } = event.value
			yield* Effect.annotateCurrentSpan({
				"maple.cloud_security.source": source,
				"maple.aws.region": region,
				"maple.cloud_security.findings": findings.length,
				"maple.cloud_security.skipped": skipped,
				"maple.cloud_security.over_cap": overCap,
			})
			// Only the poller closes what a region no longer reports: a region it does not read
			// would keep its findings open for good.
			if (!(yield* store.knowsRegion(orgId, connectionId, region))) {
				return ignored("unknown_region", orgId)
			}
			yield* store.upsertFindings(
				Arr.map(findings, (finding) => ({
					...finding,
					orgId,
					provider: "aws" as const,
					connectionId,
					accountId,
					region,
					source,
				})),
				syncedAt,
			)
			yield* store.recordPush({ orgId, provider: "aws", connectionId, region, source }, syncedAt)
			return {
				outcome: "stored",
				reason: null,
				orgId,
				findings: findings.length,
				skipped,
			} satisfies CloudSecurityEventReceipt
		})

		return { eventsKey, authenticate, accept } satisfies CloudSecurityEventsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(CloudSecurityStore.layer))
}
