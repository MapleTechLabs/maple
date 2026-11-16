/**
 * Pulls every security-module AWS connection's findings from GuardDuty, Security Hub, Inspector and
 * IAM Access Analyzer, region by region, into `CloudSecurityStore`. Maple assumes the connection's
 * role with its own OIDC token and keeps no credential.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { type AwsConnectionRow, AwsConnections } from "@maple/db/tables"
import { awsConnectionResourceNames, awsOidcIssuer, awsOidcSubject, awsRoleArn } from "@maple/domain/aws"
import { CloudSecurityFeed } from "@maple/domain/cloud-security"
import type { IntegrationsPersistenceError } from "@maple/domain/http"
import { IntegrationsPersistenceError as PersistenceError } from "@maple/domain/http"
import { AwsRegion } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { type AwsApiError, assumeRole } from "../integrations/aws/api"
import { type AwsOidcSigner, makeAwsOidcSigner } from "../integrations/aws/oidc"
import { pollFleet } from "../integrations/poll-fleet"
import { AuditTrailService } from "../audit-trail/AuditTrailService"
import { CLOSED_FINDING_RETENTION_MS, CloudSecurityStore } from "./CloudSecurityStore"

// The SDK modules of four services are large: they load with the first poll, not with the Worker.
const readers = Effect.promise(() => import("./aws-security-readers"))

/** A service found off in a region is asked again after this long, not every tick. */
export const NOT_ENABLED_RECHECK_MS = 60 * 60 * 1000
/** Region x service reads one connection runs at once: each holds one of the Worker's connections. */
const READ_CONCURRENCY = 4
const FALLBACK_REGION = Schema.decodeSync(AwsRegion)("us-east-1")

export interface AwsSecurityPollSummary {
	readonly connections: number
	readonly failedConnections: number
	readonly reads: number
	readonly findings: number
	readonly auditEvents: number
}

interface ConnectionPoll {
	readonly reads: number
	readonly findings: number
	readonly auditEvents: number
	readonly failed: boolean
}

export interface AwsSecurityFindingsServiceApi {
	readonly pollAll: Effect.Effect<AwsSecurityPollSummary, IntegrationsPersistenceError>
}

/** A role that cannot be assumed fails the connection's poll; the connection check reports why. */
class AssumeFailed extends Schema.TaggedError<AssumeFailed>()("@maple/backend/cloud-security/AssumeFailed", {
	message: Schema.String,
}) {}

const toPersistenceError = makePersistenceErrorMapper(PersistenceError, "AWS connections are unavailable")

export class AwsSecurityFindingsService extends Context.Service<
	AwsSecurityFindingsService,
	AwsSecurityFindingsServiceApi
>()("@maple/backend/services/AwsSecurityFindingsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const httpClient = yield* HttpClient.HttpClient
		const featureFlags = yield* OrganizationFeatureFlagsService
		const store = yield* CloudSecurityStore
		const auditTrail = yield* AuditTrailService
		const dbExecute = makeDbExecute(database, "AwsSecurityFindingsService", toPersistenceError)

		// Without a usable key no role can be assumed, and nothing is polled.
		const signer: AwsOidcSigner | undefined = yield* Option.match(env.MAPLE_AWS_OIDC_SIGNING_KEY, {
			onNone: () => Effect.undefined,
			onSome: (key) =>
				makeAwsOidcSigner(awsOidcIssuer(env.MAPLE_API_BASE_URL), key).pipe(
					Effect.catchTag("@maple/backend/integrations/AwsOidcKeyError", (error) =>
						Effect.logWarning(`AWS security findings disabled: ${error.message}`).pipe(
							Effect.as(undefined),
						),
					),
				),
		})

		const sessionOf = (signerKey: AwsOidcSigner, row: AwsConnectionRow) =>
			Effect.gen(function* () {
				const names = awsConnectionResourceNames(row.id)
				const token = yield* Clock.currentTimeMillis.pipe(
					Effect.flatMap((issuedAt) => signerKey.mint(awsOidcSubject(row.id), issuedAt)),
					Effect.mapError((error) => new AssumeFailed({ message: error.message })),
				)
				return yield* assumeRole(httpClient, token, {
					roleArn: awsRoleArn(row.accountId, names.roleName),
					roleName: names.roleName,
					sessionName: names.sessionName,
				}).pipe(Effect.mapError((error: AwsApiError) => new AssumeFailed({ message: error.message })))
			})

		const pollConnection = Effect.fn("AwsSecurityFindingsService.pollConnection")(function* (
			signerKey: AwsOidcSigner,
			row: AwsConnectionRow,
		) {
			yield* Effect.annotateCurrentSpan({ orgId: row.orgId, "maple.aws.connection_id": row.id })
			const { enabledRegions, readCloudTrail, readSource } = yield* readers
			const session = yield* sessionOf(signerKey, row)
			const states = yield* store.serviceStates(row.orgId, row.id)
			// A role from an old stack may not list regions: read the ones read before, or the stack's.
			const regions = yield* enabledRegions(httpClient, session).pipe(
				Effect.catchTag("@maple/backend/cloud-security/AwsSecurityReadError", (error) =>
					Effect.logWarning("AWS ListRegions failed; polling known regions").pipe(
						Effect.annotateLogs({ error: error.message }),
						Effect.as(
							Arr.match(Arr.dedupe(Arr.map(states, (state) => state.region)), {
								onEmpty: () => [FALLBACK_REGION],
								onNonEmpty: (known) => known,
							}),
						),
					),
				),
			)
			const now = yield* Clock.currentTimeMillis
			const stateOf = (region: AwsRegion, source: CloudSecurityFeed) =>
				Arr.findFirst(states, (state) => state.region === region && state.source === source)
			const due = Arr.filter(
				Arr.flatMap(regions, (region) =>
					Arr.map(CloudSecurityFeed.literals, (source) => ({ region, source })),
				),
				({ region, source }) =>
					Option.match(stateOf(region, source), {
						onNone: () => true,
						onSome: (state) =>
							state.state !== "not_enabled" || now - state.checkedAt >= NOT_ENABLED_RECHECK_MS,
					}),
			)
			const counts = yield* Effect.forEach(
				due,
				({ region, source }) =>
					Effect.gen(function* () {
						const cursorAt = Option.getOrNull(
							Option.flatMap(stateOf(region, source), (state) =>
								Option.fromNullOr(state.cursorAt),
							),
						)
						const target = { httpClient, session, accountId: row.accountId, region, cursorAt }
						const state = { orgId: row.orgId, connectionId: row.id, region, source }
						if (source === "cloudtrail") {
							const trail = yield* readCloudTrail(target, now)
							yield* auditTrail.write(row.orgId, trail.events)
							const checkedAt = yield* Clock.currentTimeMillis
							yield* store.recordServiceState({
								...state,
								state: trail.state,
								cursorAt: trail.cursorAt,
								lastError: trail.lastError,
								checkedAt,
							})
							return { findings: 0, auditEvents: trail.events.length }
						}
						const read = yield* readSource(source, target)
						const checkedAt = yield* Clock.currentTimeMillis
						yield* store.upsertFindings(
							Arr.map(read.findings, (finding) => ({
								...finding,
								orgId: row.orgId,
								connectionId: row.id,
								accountId: row.accountId,
								region,
								source,
							})),
							checkedAt,
						)
						yield* store.recordServiceState({
							...state,
							state: read.state,
							cursorAt: read.cursorAt,
							lastError: read.lastError,
							checkedAt,
						})
						return { findings: read.findings.length, auditEvents: 0 }
					}),
				{ concurrency: READ_CONCURRENCY },
			)
			yield* store.pruneClosed(row.orgId, now - CLOSED_FINDING_RETENTION_MS)
			const findings = Arr.reduce(counts, 0, (total, count) => total + count.findings)
			const auditEvents = Arr.reduce(counts, 0, (total, count) => total + count.auditEvents)
			yield* Effect.annotateCurrentSpan({
				"maple.aws.regions": regions.length,
				"maple.cloud_security.reads": due.length,
				"maple.cloud_security.findings": findings,
				"maple.cloud_security.audit_events": auditEvents,
			})
			return { reads: due.length, findings, auditEvents, failed: false } satisfies ConnectionPoll
		})

		const pollAll = Effect.gen(function* () {
			if (signer === undefined)
				return { connections: 0, failedConnections: 0, reads: 0, findings: 0, auditEvents: 0 }
			// Every org's connections: the module filter is jsonb, so it is applied here.
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(AwsConnections)
						.select()
						.where(($) => [$.grantedModules.isNotNull()]),
				),
			)
			const granted = Arr.filter(
				rows,
				(row) =>
					Arr.contains(row.modules, "security") &&
					Arr.contains(row.grantedModules ?? [], "security"),
			)
			const eligible = yield* Effect.filter(granted, (row) =>
				Effect.map(featureFlags.flags(row.orgId), (flags) => flags.cloudSecurity),
			)
			const polls = yield* pollFleet(eligible, (row) => pollConnection(signer, row), {
				message: "AWS security findings poll failed",
				annotations: (row) => ({ orgId: row.orgId, connectionId: row.id }),
				fallback: (): ConnectionPoll => ({ reads: 0, findings: 0, auditEvents: 0, failed: true }),
			})
			const summary = {
				connections: eligible.length,
				failedConnections: Arr.filter(polls, (poll) => poll.failed).length,
				reads: Arr.reduce(polls, 0, (total, poll) => total + poll.reads),
				findings: Arr.reduce(polls, 0, (total, poll) => total + poll.findings),
				auditEvents: Arr.reduce(polls, 0, (total, poll) => total + poll.auditEvents),
			} satisfies AwsSecurityPollSummary
			yield* Effect.annotateCurrentSpan({
				"maple.cloud_security.connections": summary.connections,
				"maple.cloud_security.failed_connections": summary.failedConnections,
				"maple.cloud_security.findings": summary.findings,
			})
			return summary
		}).pipe(Effect.withSpan("AwsSecurityFindingsService.pollAll"))

		return { pollAll } satisfies AwsSecurityFindingsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide([
			CloudSecurityStore.layer,
			AuditTrailService.layer,
			FetchHttpClient.layer,
			OrganizationFeatureFlagsService.layer,
		]),
	)
}
