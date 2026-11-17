/**
 * Pulls every security-module AWS connection's findings from GuardDuty, Security Hub, Inspector and
 * IAM Access Analyzer, region by region, into `CloudSecurityStore`. Maple assumes the connection's
 * role with its own OIDC token and keeps no credential.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { type AwsConnectionRow, AwsConnections } from "@maple/db/tables"
import { awsConnectionResourceNames, awsOidcIssuer, awsOidcSubject, awsRoleArn } from "@maple/domain/aws"
import {
	CloudSecurityFeed,
	type CloudServiceState,
	CLOUD_SECURITY_PUSH_ALIVE_MS,
} from "@maple/domain/cloud-security"
import type { IntegrationsPersistenceError } from "@maple/domain/http"
import { IntegrationsPersistenceError as PersistenceError } from "@maple/domain/http"
import { AwsRegion } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Order, Random, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { type AwsApiError, assumeRole } from "../integrations/aws/api"
import { type AwsOidcSigner, makeAwsOidcSigner } from "../integrations/aws/oidc"
import { pollFleet } from "../integrations/poll-fleet"
import { AuditTrailService } from "../audit-trail/AuditTrailService"
import type { FindingRead } from "./aws-security-readers"
import { CLOSED_FINDING_RETENTION_MS, CloudSecurityStore } from "./CloudSecurityStore"

// The SDK modules of four services are large: they load with the first poll, not with the Worker.
const readers = Effect.promise(() => import("./aws-security-readers"))

/** A service found off, or refused, in a region is asked again after this long, not every tick. */
export const NOT_ENABLED_RECHECK_MS = 60 * 60 * 1000
/** A findings feed whose events arrive is still read this often, for what an event missed. */
export const PUSHED_POLL_MS = 30 * 60 * 1000
/** An open finding not synced for this long is refreshed by id: a console change may not touch its update time. */
export const RECONCILE_AFTER_MS = 60 * 60 * 1000
/** Findings one feed refreshes by id per poll. */
const RECONCILE_BATCH = 100
/** Reads one connection runs at once, and connections polled at once: four fetches, under the Worker's six. */
const READ_CONCURRENCY = 2
const CONNECTION_CONCURRENCY = 2
/** A tick stops starting reads after this long, inside the lane's 270 s; the rest wait for the next one. */
export const TICK_BUDGET_MS = 200 * 1000
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

interface FeedPoll {
	readonly read: boolean
	readonly findings: number
	readonly auditEvents: number
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
			deadlineMs: number,
		) {
			yield* Effect.annotateCurrentSpan({
				"tenant.orgId": row.orgId,
				"maple.aws.connection_id": row.id,
			})
			// Past the tick's budget: not even the role is assumed; the next tick starts with it.
			if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
				yield* Effect.annotateCurrentSpan("maple.cloud_security.deferred_connection", true)
				return { reads: 0, findings: 0, auditEvents: 0, failed: false } satisfies ConnectionPoll
			}
			const { enabledRegions, readCloudTrail, readSource, refreshFindings } = yield* readers
			const session = yield* sessionOf(signerKey, row)
			const states = yield* store.serviceStates(row.orgId, row.id)
			// A role from an old stack may not list regions: read the ones read before, or the stack's.
			const regions = yield* enabledRegions(httpClient, session).pipe(
				Effect.catchTag("@maple/backend/cloud-security/AwsSecurityReadError", (error) =>
					Effect.logWarning("AWS ListRegions failed; polling known regions").pipe(
						Effect.annotateLogs({ error: error.message, orgId: row.orgId, connectionId: row.id }),
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
			const checkedAtOf = (region: AwsRegion, source: CloudSecurityFeed) =>
				Option.match(stateOf(region, source), { onNone: () => 0, onSome: (state) => state.checkedAt })
			// Least recently read first, so a tick cut short by its budget rotates through every feed.
			const due = Arr.sort(
				Arr.filter(
					Arr.flatMap(regions, (region) =>
						Arr.map(CloudSecurityFeed.literals, (source) => ({ region, source })),
					),
					({ region, source }) =>
						Option.match(stateOf(region, source), {
							onNone: () => true,
							onSome: (state) => {
								if (state.state === "not_enabled" || state.state === "denied")
									return now - state.checkedAt >= NOT_ENABLED_RECHECK_MS
								// Events carry this feed's changes: the poll only reconciles what one missed. A read
								// that is catching up or failing keeps going every tick, events or not.
								const pushed =
									state.state === "enabled" &&
									state.lastError === null &&
									state.pushedAt !== null &&
									now - state.pushedAt <= CLOUD_SECURITY_PUSH_ALIVE_MS
								return !pushed || now - state.checkedAt >= PUSHED_POLL_MS
							},
						}),
				),
				Order.mapInput(Order.Number, (feed: { region: AwsRegion; source: CloudSecurityFeed }) =>
					checkedAtOf(feed.region, feed.source),
				),
			)
			const polls = yield* Effect.forEach(
				due,
				({ region, source }) =>
					Effect.gen(function* () {
						if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
							return { read: false, findings: 0, auditEvents: 0 } satisfies FeedPoll
						}
						const cursorAt = Option.getOrNull(
							Option.flatMap(stateOf(region, source), (state) =>
								Option.fromNullOr(state.cursorAt),
							),
						)
						const target = {
							httpClient,
							session,
							accountId: row.accountId,
							region,
							cursorAt,
							windowMs: Option.getOrNull(
								Option.flatMap(stateOf(region, source), (state) =>
									Option.fromNullOr(state.windowMs),
								),
							),
							nowMs: now,
							deadlineMs,
						}
						const recordState = (read: {
							readonly state: CloudServiceState
							readonly cursorAt: number | null
							readonly windowMs: number | null
							readonly lastError: string | null
						}) =>
							Effect.flatMap(Clock.currentTimeMillis, (checkedAt) =>
								store.recordServiceState({
									orgId: row.orgId,
									connectionId: row.id,
									region,
									source,
									state: read.state,
									cursorAt: read.cursorAt,
									windowMs: read.windowMs,
									lastError: read.lastError,
									checkedAt,
								}),
							)
						if (source === "cloudtrail") {
							const trail = yield* readCloudTrail(target, (events) =>
								auditTrail.write(row.orgId, events),
							)
							yield* recordState(trail)
							return { read: true, findings: 0, auditEvents: trail.events } satisfies FeedPoll
						}
						const feed = { orgId: row.orgId, connectionId: row.id, region, source }
						const write = (findings: ReadonlyArray<FindingRead>) =>
							Effect.flatMap(Clock.currentTimeMillis, (syncedAt) =>
								store.upsertFindings(
									Arr.map(findings, (finding) => ({
										...finding,
										orgId: row.orgId,
										connectionId: row.id,
										accountId: row.accountId,
										region,
										source,
									})),
									syncedAt,
								),
							)
						const read = yield* readSource(source, target, write)
						if (read.state === "enabled" && read.seenIds !== null) {
							yield* store.resolve(feed, { except: read.seenIds }, now)
						}
						// Inspector too: a second it skipped may hold updates no later read sees.
						const beforeDeadline = (yield* Clock.currentTimeMillis) < deadlineMs
						if (read.state === "enabled" && source !== "access_analyzer" && beforeDeadline) {
							const stale = yield* store.staleIds(
								feed,
								now - RECONCILE_AFTER_MS,
								RECONCILE_BATCH,
							)
							if (stale.length > 0) {
								const refreshed = yield* refreshFindings(source, target, stale)
								yield* write(refreshed.found)
								yield* store.resolve(feed, { only: refreshed.missing }, now)
							}
						}
						yield* recordState(read)
						return { read: true, findings: read.findings, auditEvents: 0 } satisfies FeedPoll
					}),
				{ concurrency: READ_CONCURRENCY },
			)
			yield* store.pruneClosed(row.orgId, now - CLOSED_FINDING_RETENTION_MS)
			const reads = Arr.filter(polls, (poll) => poll.read).length
			const findings = Arr.reduce(polls, 0, (total, poll) => total + poll.findings)
			const auditEvents = Arr.reduce(polls, 0, (total, poll) => total + poll.auditEvents)
			yield* Effect.annotateCurrentSpan({
				"maple.aws.regions": regions.length,
				"maple.cloud_security.reads": reads,
				"maple.cloud_security.deferred": due.length - reads,
				"maple.cloud_security.findings": findings,
				"maple.cloud_security.audit_events": auditEvents,
			})
			return { reads, findings, auditEvents, failed: false } satisfies ConnectionPoll
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
			const deadlineMs = (yield* Clock.currentTimeMillis) + TICK_BUDGET_MS
			// A random order each tick: when the budget runs out, no connection is always the one left out.
			const order = yield* Random.shuffle(eligible)
			const polls = yield* pollFleet(
				order,
				(row) => pollConnection(signer, row, deadlineMs),
				{
					message: "AWS security findings poll failed",
					annotations: (row) => ({ orgId: row.orgId, connectionId: row.id }),
					fallback: (): ConnectionPoll => ({ reads: 0, findings: 0, auditEvents: 0, failed: true }),
				},
				CONNECTION_CONCURRENCY,
			)
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
