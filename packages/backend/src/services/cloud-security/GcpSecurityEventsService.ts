/**
 * Security Command Center notifications, pushed by the connector's Pub/Sub subscription. The
 * connector id in the path says whose; the Google-signed token says the push is that connector's
 * subscription. A finding lands only where the poller has read already, so closing what is gone
 * stays the poller's.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { GcpConnectors } from "@maple/db/tables"
import { IntegrationsPersistenceError } from "@maple/domain/http"
import { GcpConnectorId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import {
	GooglePushTokens,
	gcpPushServiceAccount,
	gcpSecurityPushEndpoint,
} from "../integrations/gcp/security-push"
import { CloudSecurityStore } from "./CloudSecurityStore"
import { readSccFinding } from "./scc-findings"

export class GcpSecurityEventRejected extends Schema.TaggedError<GcpSecurityEventRejected>()(
	"@maple/backend/cloud-security/GcpSecurityEventRejected",
	{
		message: Schema.String,
		/** `unknown_connector`: 404. `bad_token`: 403. `malformed`: 400. */
		reason: Schema.Literals(["unknown_connector", "bad_token", "malformed"]),
	},
) {}

export interface GcpSecurityEventReceipt {
	readonly outcome: "stored" | "ignored"
	readonly reason: string | null
}

export interface GcpSecurityEventsServiceApi {
	readonly accept: (
		rawConnectorId: string,
		bearerToken: string,
		body: string,
	) => Effect.Effect<GcpSecurityEventReceipt, GcpSecurityEventRejected | IntegrationsPersistenceError>
}

const decodeConnectorId = Schema.decodeUnknownOption(GcpConnectorId)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"GCP security events are unavailable",
)

const ignored = (reason: string): GcpSecurityEventReceipt => ({ outcome: "ignored", reason })

export class GcpSecurityEventsService extends Context.Service<
	GcpSecurityEventsService,
	GcpSecurityEventsServiceApi
>()("@maple/backend/services/GcpSecurityEventsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "GcpSecurityEventsService", toPersistenceError)
		const env = yield* Env
		const tokens = yield* GooglePushTokens
		const store = yield* CloudSecurityStore
		const featureFlags = yield* OrganizationFeatureFlagsService

		const accept = Effect.fn("GcpSecurityEventsService.accept")(function* (
			rawConnectorId: string,
			bearerToken: string,
			body: string,
		) {
			const unknown = new GcpSecurityEventRejected({
				message: "No such connector",
				reason: "unknown_connector",
			})
			const connectorId = decodeConnectorId(rawConnectorId)
			if (Option.isNone(connectorId)) return yield* unknown
			const badToken = new GcpSecurityEventRejected({
				message: "Invalid push token",
				reason: "bad_token",
			})
			// The token first: it must name this endpoint, so a forged push costs no database read.
			const signed = yield* tokens
				.verify(bearerToken, {
					audience: gcpSecurityPushEndpoint(env.MAPLE_API_BASE_URL, connectorId.value),
				})
				.pipe(
					Effect.tapError((error) =>
						Effect.annotateCurrentSpan("maple.gcp_security.token_rejected", error.reason),
					),
					Effect.mapError(() => badToken),
				)
			// Looked up by id alone: the push names no org, and the signer is checked against this row.
			const [row] = yield* dbExecute((db) =>
				db.run(
					PG.from(GcpConnectors)
						.select("id", "orgId", "projectId", "scopeId", "securityEnabled")
						.where(($) => [$.id.eq(connectorId.value)])
						.limit(1),
				),
			)
			if (row === undefined) return yield* unknown
			yield* Effect.annotateCurrentSpan({ "tenant.orgId": row.orgId, "maple.gcp.connector_id": row.id })
			if (signed.email !== gcpPushServiceAccount(row)) {
				yield* Effect.annotateCurrentSpan("maple.gcp_security.token_rejected", "wrong_account")
				return yield* badToken
			}
			// Answered 2xx so Pub/Sub stops redelivering what Maple will not keep.
			if (!row.securityEnabled) return ignored("security_off")
			if (!(yield* featureFlags.flags(row.orgId)).cloudSecurity) return ignored("rollout")
			const json = decodeJson(body)
			if (Option.isNone(json))
				return yield* new GcpSecurityEventRejected({
					message: "Body is not JSON",
					reason: "malformed",
				})
			const now = yield* Clock.currentTimeMillis
			const read = readSccFinding(json.value, row.scopeId, now)
			if (Option.isNone(read)) return ignored("not_a_finding")
			const { accountId, region, finding } = read.value
			// Only where the poller has read successfully: closing what is gone stays the poller's.
			const states = yield* store.serviceStates(row.orgId, row.id)
			const readable = Arr.some(
				states,
				(state) =>
					state.source === "security_command_center" &&
					state.region === region &&
					state.state === "enabled",
			)
			if (!readable) return ignored("unknown_location")
			yield* store.upsertFindings(
				[
					{
						...finding,
						orgId: row.orgId,
						provider: "gcp",
						connectionId: row.id,
						accountId,
						region,
						source: "security_command_center",
					},
				],
				now,
			)
			yield* store.recordPush(
				{
					orgId: row.orgId,
					provider: "gcp",
					connectionId: row.id,
					region,
					source: "security_command_center",
				},
				now,
			)
			yield* Effect.annotateCurrentSpan({
				"maple.cloud_security.severity": finding.severity,
				"maple.cloud_security.status": finding.status,
			})
			return { outcome: "stored", reason: null } satisfies GcpSecurityEventReceipt
		})

		return { accept } satisfies GcpSecurityEventsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide([
			CloudSecurityStore.layer,
			GooglePushTokens.layer,
			OrganizationFeatureFlagsService.layer,
		]),
	)
}
