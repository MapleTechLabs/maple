// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import { ownBillingCustomer } from "@maple/backend/services/billing/billing-customer"
import { randomBytes, randomUUID } from "node:crypto"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertDestinations,
	AlertRuleClaims,
	AlertRules,
	UptimeMonitorStates,
	UptimeMonitors,
	type UptimeMonitorRow,
	type UptimeMonitorStateRow,
	OrgBillingLinks,
} from "@maple/db/tables"
import {
	UptimeMonitorLimitReachedError,
	UptimeMonitorNotFoundError,
	UptimeMonitorPersistenceError,
	UptimeMonitorValidationError,
} from "@maple/domain/http"
import {
	AlertDestinationId,
	AlertRuleId,
	UptimeIntervalSeconds,
	UptimeMonitorId,
	UptimeMonitorKind,
	UptimeMonitorStatus,
	type OrgId,
	type UserId,
} from "@maple/domain/primitives"
import {
	appendRecentCheck,
	applyUptimeCheck,
	effectiveAssertions,
	firstFailedAssertion,
	heartbeatDeadline,
	uptimeHttpRequest,
	UPTIME_REDACTED_HEADER_VALUE,
	UptimeCheckDetail,
	UptimeMonitorConfig,
	UptimeRecentCheck,
	type UptimeCheckReport,
	type UptimeMonitorStateSnapshot,
	type UptimeProbeConfig,
} from "@maple/domain/uptime"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Order, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	describeHttpClientError,
	guard,
	isPrivateAddress,
	readTextPrefix,
	validateExternalUrl,
} from "@maple/safe-fetch"
import type { MapleDb } from "@maple/db/client"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { msToSqlTimestamp } from "@maple/backend/platform/time"
import { Env } from "@maple/backend/platform/Env"
import { ensureWithinLimit, UptimeMonitorAllowance } from "./UptimeMonitorAllowance"
import { uptimeRuleFields } from "@maple/backend/services/alerts/AlertRuleModel"
import { deleteRuleRows } from "@maple/backend/services/alerts/AlertRulesService"

/** The state changed between a ping's read and its write; the ping is read and applied again. */
class UptimeHeartbeatPingConflict extends Schema.TaggedError<UptimeHeartbeatPingConflict>()(
	"@maple/backend/uptime/HeartbeatPingConflict",
	{ message: Schema.String },
) {}

/** Attempts after the first before a ping that keeps losing its race gives up with a 503. */
const PING_CONFLICT_RETRIES = 4

/** An unknown, disabled or non-heartbeat token was pinged. */
export class UptimeHeartbeatNotFound extends Schema.TaggedError<UptimeHeartbeatNotFound>()(
	"@maple/backend/uptime/HeartbeatNotFound",
	{ message: Schema.String },
) {}

export interface UptimeMonitorStateView {
	readonly status: UptimeMonitorStatus
	readonly consecutiveFailures: number
	readonly consecutiveSuccesses: number
	readonly statusChangedAt: number | null
	readonly lastCheck: UptimeCheckDetail | null
	readonly recent: ReadonlyArray<UptimeRecentCheck>
	readonly lastPingAt: number | null
}

export interface UptimeMonitorRecord {
	readonly id: UptimeMonitorId
	readonly orgId: OrgId
	readonly name: string
	readonly kind: UptimeMonitorKind
	readonly config: UptimeMonitorConfig
	readonly intervalSeconds: UptimeIntervalSeconds
	readonly failuresToDown: number
	readonly serviceName: string | null
	readonly enabled: boolean
	/** Where a down monitor notifies: the destinations of its backing alert rule. */
	readonly destinationIds: ReadonlyArray<AlertDestinationId>
	/** The hidden `uptime` alert rule that turns a down state into an incident. */
	readonly alertRuleId: AlertRuleId | null
	/** Heartbeats only: the full ping URL (`<api>/hb/<token>`). */
	readonly heartbeatUrl: string | null
	readonly state: UptimeMonitorStateView
	readonly createdAt: number
	readonly updatedAt: number
}

export interface CreateUptimeMonitorInput {
	readonly name: string
	readonly kind: UptimeMonitorKind
	readonly config: UptimeMonitorConfig
	readonly intervalSeconds?: UptimeIntervalSeconds
	readonly failuresToDown?: number
	readonly serviceName?: string | null
	readonly enabled?: boolean
	readonly destinationIds?: ReadonlyArray<AlertDestinationId>
	readonly createdBy: UserId
}

export interface UpdateUptimeMonitorInput {
	readonly name?: string
	readonly config?: UptimeMonitorConfig
	readonly intervalSeconds?: UptimeIntervalSeconds
	readonly failuresToDown?: number
	readonly serviceName?: string | null
	readonly enabled?: boolean
	readonly destinationIds?: ReadonlyArray<AlertDestinationId>
	/** Recorded on the backing alert rule. */
	readonly updatedBy: UserId
}

/** A probe target as the scraper needs it, before the route adds the org's ingest key. */
export interface UptimeProbeTargetRow {
	readonly id: UptimeMonitorId
	readonly orgId: OrgId
	readonly name: string
	readonly serviceName: string | null
	readonly intervalSeconds: number
	readonly config: UptimeProbeConfig
}

export interface UptimeHttpTestResult {
	readonly ok: boolean
	readonly statusCode: number | null
	readonly durationMs: number
	readonly failedAssertion: string | null
	readonly error: string | null
	readonly headers: Readonly<Record<string, string>>
	readonly bodyPrefix: string | null
	readonly bodyTruncated: boolean
}

export interface UptimeMonitorsServiceApi {
	readonly list: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<UptimeMonitorRecord>, UptimeMonitorPersistenceError>
	readonly get: (
		orgId: OrgId,
		monitorId: UptimeMonitorId,
	) => Effect.Effect<UptimeMonitorRecord, UptimeMonitorNotFoundError | UptimeMonitorPersistenceError>
	readonly create: (
		orgId: OrgId,
		input: CreateUptimeMonitorInput,
	) => Effect.Effect<
		UptimeMonitorRecord,
		UptimeMonitorValidationError | UptimeMonitorPersistenceError | UptimeMonitorLimitReachedError
	>
	readonly update: (
		orgId: OrgId,
		monitorId: UptimeMonitorId,
		input: UpdateUptimeMonitorInput,
	) => Effect.Effect<
		UptimeMonitorRecord,
		UptimeMonitorNotFoundError | UptimeMonitorValidationError | UptimeMonitorPersistenceError
	>
	readonly delete: (
		orgId: OrgId,
		monitorId: UptimeMonitorId,
	) => Effect.Effect<UptimeMonitorId, UptimeMonitorNotFoundError | UptimeMonitorPersistenceError>
	/** Every enabled http/tcp/dns monitor across orgs, for the scraper. */
	readonly listProbeTargets: () => Effect.Effect<
		ReadonlyArray<UptimeProbeTargetRow>,
		UptimeMonitorPersistenceError
	>
	/** Applies a batch of scraper results; returns how many monitors changed. */
	readonly recordChecks: (
		reports: ReadonlyArray<UptimeCheckReport>,
	) => Effect.Effect<number, UptimeMonitorPersistenceError>
	/** A heartbeat ping: `ok` marks the monitor up, a failure marks it down at once. */
	readonly recordPing: (
		token: string,
		ok: boolean,
	) => Effect.Effect<void, UptimeHeartbeatNotFound | UptimeMonitorPersistenceError>
	/** Runs one HTTP check now, saving nothing. */
	readonly testHttp: (
		config: UptimeMonitorConfig,
	) => Effect.Effect<UptimeHttpTestResult, UptimeMonitorValidationError>
}

const DEFAULT_INTERVAL_SECONDS = UptimeIntervalSeconds.make(60)
const DEFAULT_FAILURES_TO_DOWN = 2
const MAX_FAILURES_TO_DOWN = 10
/** Body read to evaluate a test's assertions; only `TEST_BODY_PREFIX_CHARS` of it is returned. */
const TEST_BODY_READ_BYTES = 64 * 1024
const TEST_BODY_PREFIX_CHARS = 2048
const HOST_PATTERN = /^[A-Za-z0-9.:-]+$/u
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/u

const toPersistenceError = (error: unknown) =>
	new UptimeMonitorPersistenceError({
		message: error instanceof Error ? error.message : "Uptime monitor persistence failed",
		cause: error,
	})

const invalid = (message: string) => new UptimeMonitorValidationError({ message })

const notFound = (monitorId: UptimeMonitorId) =>
	new UptimeMonitorNotFoundError({ monitorId, message: "Uptime monitor not found" })

const validateUrl = (url: string) =>
	validateExternalUrl(url).pipe(
		Effect.asVoid,
		Effect.mapError((error) => invalid(error.message)),
	)

/** A TCP/DNS host: a public name or IP, judged like a URL host. */
const validateHost = (host: string) => {
	const bare = host.trim().replace(/^\[|\]$/gu, "")
	if (!HOST_PATTERN.test(bare))
		return Effect.fail(invalid(`'${host}' is not a valid hostname or IP address`))
	const isIp = bare.includes(":") || IPV4_PATTERN.test(bare)
	if (isIp && isPrivateAddress(bare)) {
		return Effect.fail(invalid(`Host '${host}' is not allowed (loopback, private, or metadata range)`))
	}
	return validateUrl(`http://${bare.includes(":") ? `[${bare}]` : bare}/`)
}

const decodeConfig = Schema.decodeUnknownEffect(UptimeMonitorConfig)

/** The config as stored: schema checks, the kind it belongs to, and hosts Maple may reach. */
const validateConfig = Effect.fnUntraced(function* (kind: UptimeMonitorKind, raw: UptimeMonitorConfig) {
	const config = yield* decodeConfig(raw).pipe(
		Effect.mapError((error) => invalid(`Invalid config: ${error.message}`)),
	)
	if (config._tag !== kind)
		return yield* invalid(`config.type '${config._tag}' does not match kind '${kind}'`)
	switch (config._tag) {
		case "http":
			if (config.body !== undefined && config.method !== "POST") {
				return yield* invalid("A request body needs the POST method")
			}
			yield* validateUrl(config.url)
			break
		case "tcp":
			yield* validateHost(config.host)
			break
		case "dns":
			yield* validateHost(config.hostname)
			break
		case "heartbeat":
			// The alert evaluator computes deadlines from this schedule, so it must have a next run.
			if (
				config.schedule._tag === "cron" &&
				Option.isNone(heartbeatDeadline(config, yield* Clock.currentTimeMillis))
			) {
				return yield* invalid(
					`'${config.schedule.expression}' in ${config.schedule.timezone} is not a valid cron schedule, or never runs`,
				)
			}
			break
	}
	return config
})

const validateName = (name: string) => {
	const trimmed = name.trim()
	return trimmed.length === 0 ? Effect.fail(invalid("Name is required")) : Effect.succeed(trimmed)
}

const validateFailuresToDown = (value: number) =>
	Number.isInteger(value) && value >= 1 && value <= MAX_FAILURES_TO_DOWN
		? Effect.succeed(value)
		: Effect.fail(invalid(`failures_to_down must be an integer between 1 and ${MAX_FAILURES_TO_DOWN}`))

const newHeartbeatToken = () => randomBytes(18).toString("base64url")

/** An update's `[redacted]` header values take the stored value back; one with none stored is refused. */
const keepRedactedHeaders = (current: UptimeMonitorConfig, next: UptimeMonitorConfig) => {
	if (next._tag !== "http") return Effect.succeed(next)
	const stored = current._tag === "http" ? current.headers : {}
	const entries = Object.entries(next.headers)
	const orphan = entries.find(
		([name, value]) => value === UPTIME_REDACTED_HEADER_VALUE && stored[name] === undefined,
	)
	if (orphan !== undefined) {
		return Effect.fail(invalid(`Header ${orphan[0]} has no stored value to keep; send its real value`))
	}
	return Effect.succeed({
		...next,
		headers: Object.fromEntries(
			entries.map(([name, value]) => [
				name,
				value === UPTIME_REDACTED_HEADER_VALUE ? (stored[name] ?? value) : value,
			]),
		),
	})
}

const originOf = (url: string): string => (URL.canParse(url) ? new URL(url).origin : url)

/** A stored header value goes only to the origin it was entered for; a new origin needs them re-entered. */
const refuseRedactedHeadersForNewOrigin = (current: UptimeMonitorConfig, next: UptimeMonitorConfig) =>
	current._tag === "http" &&
	next._tag === "http" &&
	originOf(next.url) !== originOf(current.url) &&
	Object.values(next.headers).some((value) => value === UPTIME_REDACTED_HEADER_VALUE)
		? Effect.fail(
				invalid(
					"The URL now points at a different origin; re-enter the header values instead of keeping the hidden ones",
				),
			)
		: Effect.void

type MonitorWithStateRow = Pick<
	UptimeMonitorRow,
	| "id"
	| "orgId"
	| "name"
	| "kind"
	| "configJson"
	| "intervalSeconds"
	| "failuresToDown"
	| "serviceName"
	| "alertRuleId"
	| "heartbeatToken"
	| "enabled"
	| "createdAt"
	| "updatedAt"
> & { readonly destinationIdsJson: ReadonlyArray<string> | null } & Pick<
		UptimeMonitorStateRow,
		| "status"
		| "consecutiveFailures"
		| "consecutiveSuccesses"
		| "statusChangedAt"
		| "lastCheckJson"
		| "recentJson"
		| "lastPingAt"
	> & { readonly stateUpdatedAt: number }

/** Every monitor with its state; each monitor gets its state row in the same transaction. */
const selectMonitors = () =>
	PG.from(UptimeMonitors, "m")
		.innerJoin(UptimeMonitorStates, "s", (m, s) => m.id.eq(s.monitorId).and(m.orgId.eq(s.orgId)))
		.leftJoin(AlertRules, "r", (m, r) => m.alertRuleId.eq(r.id).and(m.orgId.eq(r.orgId)))
		.select(($) => ({
			id: $.id,
			orgId: $.orgId,
			name: $.name,
			kind: $.kind,
			configJson: $.configJson,
			intervalSeconds: $.intervalSeconds,
			failuresToDown: $.failuresToDown,
			serviceName: $.serviceName,
			alertRuleId: $.alertRuleId,
			destinationIdsJson: $.r.destinationIdsJson,
			heartbeatToken: $.heartbeatToken,
			enabled: $.enabled,
			createdAt: $.createdAt,
			updatedAt: $.updatedAt,
			status: $.s.status,
			consecutiveFailures: $.s.consecutiveFailures,
			consecutiveSuccesses: $.s.consecutiveSuccesses,
			statusChangedAt: $.s.statusChangedAt,
			lastCheckJson: $.s.lastCheckJson,
			recentJson: $.s.recentJson,
			lastPingAt: $.s.lastPingAt,
			stateUpdatedAt: $.s.updatedAt,
		}))

const decodeInterval = Schema.decodeUnknownEffect(UptimeIntervalSeconds)
const decodeDestinationIds = Schema.decodeUnknownEffect(Schema.Array(AlertDestinationId))

const UpdatedStateRow = Schema.Struct({ monitor_id: Schema.String })

/** recordChecks' read: decoded columns are typed scalars, the rest are decoded per row. */
const selectCheckStates = () =>
	PG.from(UptimeMonitors, "m")
		.innerJoin(UptimeMonitorStates, "s", (m, s) => m.id.eq(s.monitorId).and(m.orgId.eq(s.orgId)))
		.select(($) => ({
			id: $.id,
			orgId: $.orgId,
			kind: PG.undecoded($.kind),
			failuresToDown: $.failuresToDown,
			status: PG.undecoded($.s.status),
			consecutiveFailures: $.s.consecutiveFailures,
			consecutiveSuccesses: $.s.consecutiveSuccesses,
			statusChangedAt: $.s.statusChangedAt,
			lastCheckJson: PG.undecoded($.s.lastCheckJson),
			recentJson: PG.undecoded($.s.recentJson),
			stateUpdatedAt: $.s.updatedAt,
		}))

const StoredCheckState = Schema.Struct({
	kind: UptimeMonitorKind,
	status: UptimeMonitorStatus,
	lastCheckJson: Schema.NullOr(UptimeCheckDetail),
	recentJson: Schema.Array(UptimeRecentCheck),
})
const decodeStoredCheckState = Schema.decodeUnknownEffect(StoredCheckState)

/** A monitor's state as a batch of checks folds into it. */
interface CheckStateRow {
	readonly id: UptimeMonitorId
	readonly orgId: OrgId
	readonly kind: UptimeMonitorKind
	readonly failuresToDown: number
	readonly status: UptimeMonitorStatus
	readonly consecutiveFailures: number
	readonly consecutiveSuccesses: number
	readonly statusChangedAt: number | null
	readonly lastCheckJson: UptimeCheckDetail | null
	readonly recentJson: ReadonlyArray<UptimeRecentCheck>
	readonly stateUpdatedAt: number
}

interface FoldedChecks {
	readonly snapshot: UptimeMonitorStateSnapshot
	readonly statusChangedAt: number | null
	readonly recent: ReadonlyArray<UptimeRecentCheck>
}

/** Applies one monitor's reports in time order, as one write per report would have. */
const foldReports = (row: CheckStateRow, reports: ReadonlyArray<UptimeCheckReport>): FoldedChecks =>
	reports.reduce<FoldedChecks>(
		(acc, report) => {
			const snapshot = applyUptimeCheck(acc.snapshot, report.ok, row.failuresToDown)
			return {
				snapshot,
				statusChangedAt:
					snapshot.status === acc.snapshot.status ? acc.statusChangedAt : report.checkedAt,
				recent: appendRecentCheck(acc.recent, {
					at: report.checkedAt,
					ok: report.ok,
					durationMs: report.durationMs,
				}),
			}
		},
		{
			snapshot: {
				status: row.status,
				consecutiveFailures: row.consecutiveFailures,
				consecutiveSuccesses: row.consecutiveSuccesses,
			},
			statusChangedAt: row.statusChangedAt,
			recent: row.recentJson,
		},
	)

const toCheckDetail = (report: UptimeCheckReport): UptimeCheckDetail => ({
	at: report.checkedAt,
	ok: report.ok,
	durationMs: report.durationMs,
	statusCode: report.statusCode,
	error: report.error,
	traceId: report.traceId,
})

type TestOutcome =
	| {
			readonly _tag: "response"
			readonly statusCode: number
			readonly durationMs: number
			readonly headers: Readonly<Record<string, string>>
			readonly body: string | null
			readonly truncated: boolean
	  }
	| { readonly _tag: "failed"; readonly error: string }

export class UptimeMonitorsService extends Context.Service<UptimeMonitorsService, UptimeMonitorsServiceApi>()(
	"@maple/backend/services/uptime/UptimeMonitorsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "UptimeMonitorsService", toPersistenceError)
			const env = yield* Env
			const allowance = yield* UptimeMonitorAllowance
			// Scoped per hop, so an unread body is cancelled on exit. A cross-origin redirect drops
			// the configured headers and keeps only the user-agent we set, as the probe does.
			const testClient = guard(HttpClient.withScope(yield* HttpClient.HttpClient), {
				strictRedirects: true,
				ownHeaders: ["user-agent"],
			})
			const apiBaseUrl = env.MAPLE_API_BASE_URL.replace(/\/+$/u, "")

			const toRecord = (row: MonitorWithStateRow) =>
				Effect.all({
					intervalSeconds: decodeInterval(row.intervalSeconds),
					destinationIds: decodeDestinationIds(row.destinationIdsJson ?? []),
				}).pipe(
					Effect.mapError(
						(error) =>
							new UptimeMonitorPersistenceError({
								message: `Stored interval or destinations of uptime monitor ${row.id} are invalid`,
								cause: error,
							}),
					),
					Effect.map(({ intervalSeconds, destinationIds }): UptimeMonitorRecord => ({
						id: row.id,
						orgId: row.orgId,
						name: row.name,
						kind: row.kind,
						config: row.configJson,
						intervalSeconds,
						failuresToDown: row.failuresToDown,
						serviceName: row.serviceName,
						enabled: row.enabled,
						destinationIds,
						alertRuleId: row.alertRuleId,
						heartbeatUrl:
							row.heartbeatToken === null ? null : `${apiBaseUrl}/hb/${row.heartbeatToken}`,
						state: {
							status: row.status,
							consecutiveFailures: row.consecutiveFailures,
							consecutiveSuccesses: row.consecutiveSuccesses,
							statusChangedAt: row.statusChangedAt,
							lastCheck: row.lastCheckJson,
							recent: row.recentJson,
							lastPingAt: row.lastPingAt,
						},
						createdAt: row.createdAt,
						updatedAt: row.updatedAt,
					})),
				)

			const requireMonitor = Effect.fn("UptimeMonitorsService.requireMonitor")(function* (
				orgId: OrgId,
				monitorId: UptimeMonitorId,
			) {
				const rows = yield* dbExecute((db) =>
					db.run(
						selectMonitors()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(monitorId)])
							.limit(1),
					),
				)
				const row = rows[0]
				if (row === undefined) return yield* notFound(monitorId)
				return yield* toRecord(row)
			})

			const list = Effect.fn("UptimeMonitorsService.list")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db.run(
						selectMonitors()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["createdAt", "desc"], ["id", "desc"]),
					),
				)
				return yield* Effect.forEach(rows, toRecord)
			})

			const get = Effect.fn("UptimeMonitorsService.get")(function* (
				orgId: OrgId,
				monitorId: UptimeMonitorId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.uptime.monitor_id": monitorId })
				return yield* requireMonitor(orgId, monitorId)
			})

			/**
			 * Checks a backing-rule write; the caller holds the org lock (`lockOrgMonitors`), which
			 * rule writes and destination deletes also take: its destinations exist, its name is free.
			 */
			const claimRuleWrite = Effect.fnUntraced(function* (
				db: MapleDb,
				orgId: OrgId,
				ruleId: AlertRuleId,
				rule: { readonly name: string; readonly destinationIds: ReadonlyArray<AlertDestinationId> },
			) {
				if (rule.destinationIds.length > 0) {
					const found = yield* db.run(
						PG.from(AlertDestinations)
							.select("id")
							.where(($) => [$.orgId.eq(orgId), $.id.in_(...rule.destinationIds)]),
					)
					const known = new Set(found.map((row) => row.id))
					const missing = rule.destinationIds.find((id) => !known.has(id))
					if (missing !== undefined) return yield* invalid(`Unknown alert destination ${missing}`)
				}
				const sameName = yield* db.run(
					PG.from(AlertRules)
						.select("id")
						.where(($) => [$.orgId.eq(orgId), $.name.eq(rule.name), $.id.neq(ruleId)])
						.limit(1),
				)
				if (sameName.length > 0) {
					return yield* invalid(
						`An alert rule or monitor named '${rule.name}' already exists; pick another name`,
					)
				}
			})

			/**
			 * The per-org lock monitor creates (and alert rule writes) take inside their transaction,
			 * so two concurrent creates cannot both pass a full plan.
			 */
			const lockOrgMonitors = (db: MapleDb, orgId: OrgId) =>
				db.execute(Orm.sql`select pg_advisory_xact_lock(hashtext(${orgId}))`)

			/**
			 * Monitors counted against the plan `orgId` bills to: the billing org's and every member's,
			 * since a member draws on its billing org's allowance. Takes that pool's lock too.
			 */
			const countPooledMonitors = (db: MapleDb, orgId: OrgId) =>
				Effect.gen(function* () {
					// Shared with other creates, exclusive with link writes: the pool cannot change mid-count.
					yield* db.execute(
						Orm.sql`select pg_advisory_xact_lock_shared(hashtext('org_billing_links'))`,
					)
					const [link] = yield* db.run(
						PG.from(OrgBillingLinks)
							.select(($) => ({ billingOrgId: $.billingOrgId }))
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					)
					const payer = link?.billingOrgId ?? orgId
					yield* db.execute(
						Orm.sql`select pg_advisory_xact_lock(hashtext(${payer}), hashtext('uptime_monitor_pool'))`,
					)
					const members = yield* db.run(
						PG.from(OrgBillingLinks)
							.select(($) => ({ orgId: $.orgId }))
							.where(($) => [$.billingOrgId.eq(payer)]),
					)
					const pool = [payer, ...members.map((member) => member.orgId)]
					const rows = yield* db.run(
						PG.from(UptimeMonitors)
							.select(() => ({ count: PG.count() }))
							.where(($) => [PG.inList($.orgId, pool)]),
					)
					return { count: Number(rows[0]?.count ?? 0), payer: ownBillingCustomer(payer) }
				})

			const create = Effect.fn("UptimeMonitorsService.create")(function* (
				orgId: OrgId,
				input: CreateUptimeMonitorInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.uptime.kind": input.kind })
				const name = yield* validateName(input.name)
				const config = yield* validateConfig(input.kind, input.config)
				const failuresToDown = yield* validateFailuresToDown(
					input.failuresToDown ?? DEFAULT_FAILURES_TO_DOWN,
				)
				// The cap is read before the transaction, for the payer as it stands now, so no Autumn
				// call runs under the link lock. Re-read under the lock only if a link moved it since.
				const [linked] = yield* dbExecute((db) =>
					db.run(
						PG.from(OrgBillingLinks)
							.select(($) => ({ billingOrgId: $.billingOrgId }))
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
				)
				const expectedPayer = ownBillingCustomer(linked?.billingOrgId ?? orgId)
				const expectedLimit = yield* allowance.limit(expectedPayer)

				const now = yield* Clock.currentTimeMillis
				const id = UptimeMonitorId.make(randomUUID())
				const ruleId = AlertRuleId.make(randomUUID())
				const enabled = input.enabled !== false
				const serviceName = input.serviceName ?? null
				const destinationIds = Arr.dedupe(input.destinationIds ?? [])
				const payer = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// One lock for the count and the rule checks: concurrent creates cannot both pass a full plan.
							yield* lockOrgMonitors(db, orgId)
							const pooled = yield* countPooledMonitors(db, orgId)
							// A link landing a moment ago changes both the pool and whose plan caps it.
							const limit =
								pooled.payer === expectedPayer
									? expectedLimit
									: yield* allowance.limit(pooled.payer)
							yield* ensureWithinLimit(limit, pooled.count)
							yield* claimRuleWrite(db, orgId, ruleId, { name, destinationIds })
							yield* db.run(
								PG.insertInto(AlertRules).values({
									id: ruleId,
									orgId,
									...uptimeRuleFields({ name, serviceName, enabled, destinationIds }),
									lastScheduledAt: null,
									createdAt: now,
									updatedAt: now,
									createdBy: input.createdBy,
									updatedBy: input.createdBy,
								}),
							)
							yield* db.run(
								PG.insertInto(UptimeMonitors).values({
									id,
									orgId,
									name,
									kind: config._tag,
									configJson: config,
									intervalSeconds: input.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
									failuresToDown,
									serviceName,
									alertRuleId: ruleId,
									heartbeatToken: config._tag === "heartbeat" ? newHeartbeatToken() : null,
									enabled,
									createdBy: input.createdBy,
									createdAt: now,
									updatedAt: now,
								}),
							)
							yield* db.run(
								PG.insertInto(UptimeMonitorStates).values({
									monitorId: id,
									orgId,
									status: enabled ? "pending" : "paused",
									consecutiveFailures: 0,
									consecutiveSuccesses: 0,
									statusChangedAt: null,
									lastCheckJson: null,
									recentJson: [],
									lastPingAt: null,
									updatedAt: now,
								}),
							)
							// Metered to the payer this create was counted against, even if a link lands next.
							return pooled.payer
						}),
					),
				)
				yield* allowance.track(payer, id, 1)
				return yield* requireMonitor(orgId, id).pipe(
					Effect.catchTag("@maple/http/errors/UptimeMonitorNotFoundError", () =>
						Effect.fail(
							new UptimeMonitorPersistenceError({
								message: "Created uptime monitor not found",
							}),
						),
					),
				)
			})

			const update = Effect.fn("UptimeMonitorsService.update")(function* (
				orgId: OrgId,
				monitorId: UptimeMonitorId,
				input: UpdateUptimeMonitorInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.uptime.monitor_id": monitorId })
				const current = yield* requireMonitor(orgId, monitorId)
				if (input.config !== undefined && input.config._tag !== current.kind) {
					return yield* invalid(
						`A ${current.kind} monitor cannot become ${input.config._tag}; create a new monitor instead`,
					)
				}
				if (input.config !== undefined)
					yield* refuseRedactedHeadersForNewOrigin(current.config, input.config)
				const config =
					input.config === undefined
						? undefined
						: yield* validateConfig(
								current.kind,
								yield* keepRedactedHeaders(current.config, input.config),
							)
				const name = input.name === undefined ? undefined : yield* validateName(input.name)
				const failuresToDown =
					input.failuresToDown === undefined
						? undefined
						: yield* validateFailuresToDown(input.failuresToDown)
				const now = yield* Clock.currentTimeMillis
				const settingsChanged =
					config !== undefined ||
					input.intervalSeconds !== undefined ||
					failuresToDown !== undefined

				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// Lock, then re-read: the rule comes from a row no other write changes before
							// commit, and a concurrent delete either finished first or waits for this one.
							yield* lockOrgMonitors(db, orgId)
							const lockedRows = yield* db.run(
								selectMonitors()
									.where(($) => [$.orgId.eq(orgId), $.id.eq(monitorId)])
									.limit(1),
							)
							const lockedRow = lockedRows[0]
							if (lockedRow === undefined) return yield* notFound(monitorId)
							const locked = yield* toRecord(lockedRow)
							const rule = {
								name: name ?? locked.name,
								serviceName:
									input.serviceName === undefined ? locked.serviceName : input.serviceName,
								enabled: input.enabled ?? locked.enabled,
								destinationIds:
									input.destinationIds === undefined
										? locked.destinationIds
										: Arr.dedupe(input.destinationIds),
							}
							// The backing rule is written only when it changes: alert_rules is Electric-synced.
							const ruleChanged =
								locked.alertRuleId === null ||
								rule.name !== locked.name ||
								rule.serviceName !== locked.serviceName ||
								rule.enabled !== locked.enabled ||
								rule.destinationIds.length !== locked.destinationIds.length ||
								rule.destinationIds.some((id, index) => id !== locked.destinationIds[index])
							const ruleId = locked.alertRuleId ?? AlertRuleId.make(randomUUID())
							const enabledChange =
								input.enabled !== undefined && input.enabled !== locked.enabled
									? Option.some(input.enabled)
									: Option.none<boolean>()
							if (ruleChanged) {
								yield* claimRuleWrite(db, orgId, ruleId, rule)
								yield* locked.alertRuleId === null
									? db.run(
											PG.insertInto(AlertRules).values({
												id: ruleId,
												orgId,
												...uptimeRuleFields(rule),
												lastScheduledAt: null,
												createdAt: now,
												updatedAt: now,
												createdBy: input.updatedBy,
												updatedBy: input.updatedBy,
											}),
										)
									: Effect.andThen(
											// Ends a tick's claim on the old config, as a rule edit does.
											db.run(
												PG.deleteFrom(AlertRuleClaims).where(($) => [
													$.ruleId.eq(ruleId),
												]),
											),
											db.run(
												PG.update(AlertRules)
													.set({
														...uptimeRuleFields(rule),
														updatedAt: now,
														updatedBy: input.updatedBy,
													})
													.where(($) => [$.orgId.eq(orgId), $.id.eq(ruleId)]),
											),
										)
							}
							yield* db.run(
								PG.update(UptimeMonitors)
									.set({
										...(locked.alertRuleId === null
											? { alertRuleId: ruleId }
											: undefined),
										...(name === undefined ? undefined : { name }),
										...(config === undefined ? undefined : { configJson: config }),
										...(input.intervalSeconds === undefined
											? undefined
											: { intervalSeconds: input.intervalSeconds }),
										...(failuresToDown === undefined ? undefined : { failuresToDown }),
										...(input.serviceName === undefined
											? undefined
											: { serviceName: input.serviceName }),
										...(input.enabled === undefined
											? undefined
											: { enabled: input.enabled }),
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(monitorId)]),
							)
							// Pause parks the state; resume starts over from `pending`.
							if (Option.isNone(enabledChange)) {
								// New settings drop check batches computed from the old ones (they fence on it).
								if (settingsChanged) {
									yield* db.run(
										PG.update(UptimeMonitorStates)
											.set({ updatedAt: now })
											.where(($) => [$.orgId.eq(orgId), $.monitorId.eq(monitorId)]),
									)
								}
								return
							}
							yield* db.run(
								PG.update(UptimeMonitorStates)
									.set({
										status: enabledChange.value ? "pending" : "paused",
										consecutiveFailures: 0,
										consecutiveSuccesses: 0,
										statusChangedAt: now,
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.monitorId.eq(monitorId)]),
							)
						}),
					),
				)
				return yield* requireMonitor(orgId, monitorId)
			})

			const remove = Effect.fn("UptimeMonitorsService.delete")(function* (
				orgId: OrgId,
				monitorId: UptimeMonitorId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.uptime.monitor_id": monitorId })
				// The backing rule goes with the monitor, through the rule delete's own cascade.
				const deleted = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// The lock update and rule writes take, so neither recreates a rule for a gone monitor.
							yield* lockOrgMonitors(db, orgId)
							// Shared with creates, exclusive with link writes: a link's monitor count stays exact.
							yield* db.execute(
								Orm.sql`select pg_advisory_xact_lock_shared(hashtext('org_billing_links'))`,
							)
							const removed = yield* db.run(
								PG.deleteFrom(UptimeMonitors)
									.where(($) => [$.orgId.eq(orgId), $.id.eq(monitorId)])
									.returning("id", "alertRuleId"),
							)
							const ruleId = removed[0]?.alertRuleId ?? null
							if (ruleId !== null) yield* deleteRuleRows(db, orgId, ruleId)
							// The payer as of this delete: a link or unlink after it moves the rest.
							const [link] = yield* db.run(
								PG.from(OrgBillingLinks)
									.select(($) => ({ billingOrgId: $.billingOrgId }))
									.where(($) => [$.orgId.eq(orgId)])
									.limit(1),
							)
							return { removed, payer: ownBillingCustomer(link?.billingOrgId ?? orgId) }
						}),
					),
				)
				if (deleted.removed.length === 0) return yield* notFound(monitorId)
				yield* allowance.track(deleted.payer, monitorId, -1)
				return monitorId
			})

			const listProbeTargets = Effect.fn("UptimeMonitorsService.listProbeTargets")(function* () {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(UptimeMonitors)
							.select(($) => ({
								id: $.id,
								orgId: $.orgId,
								name: $.name,
								serviceName: $.serviceName,
								intervalSeconds: $.intervalSeconds,
								configJson: PG.undecoded($.configJson),
							}))
							.where(($) => [$.enabled.eq(true), $.kind.in_("http", "tcp", "dns")]),
					),
				)
				// A config that no longer decodes skips its monitor, never the scraper's whole list.
				const targets = yield* Effect.forEach(rows, (row) =>
					decodeConfig(row.configJson).pipe(
						Effect.map((config): ReadonlyArray<UptimeProbeTargetRow> =>
							config._tag === "heartbeat"
								? []
								: [
										{
											id: row.id,
											orgId: row.orgId,
											name: row.name,
											serviceName: row.serviceName,
											intervalSeconds: row.intervalSeconds,
											config,
										},
									],
						),
						Effect.catchTag("SchemaError", (error) =>
							Effect.logWarning("Skipping uptime monitor with an undecodable config").pipe(
								Effect.annotateLogs({
									monitorId: row.id,
									orgId: row.orgId,
									cause: error.message,
								}),
								Effect.as([]),
							),
						),
					),
				)
				return Arr.flatten(targets)
			})

			const recordChecks = Effect.fn("UptimeMonitorsService.recordChecks")(function* (
				reports: ReadonlyArray<UptimeCheckReport>,
			) {
				const [firstId, ...restIds] = Arr.dedupe(reports.map((report) => report.monitorId))
				if (firstId === undefined) return 0
				yield* Effect.annotateCurrentSpan({ "maple.uptime.report_count": reports.length })
				// System path: the batch spans orgs, so the read is by id only.
				const stored = yield* dbExecute((db) =>
					db.run(
						selectCheckStates().where(($) => [$.id.in_(firstId, ...restIds), $.enabled.eq(true)]),
					),
				)
				// A row that no longer decodes is skipped, so it cannot fail every org's batch.
				const rows = yield* Effect.forEach(stored, (row) =>
					decodeStoredCheckState(row).pipe(
						Effect.map((decoded): ReadonlyArray<CheckStateRow> => [{ ...row, ...decoded }]),
						Effect.catchTag("SchemaError", (error) =>
							Effect.logWarning("Skipping uptime monitor with an undecodable state row").pipe(
								Effect.annotateLogs({
									monitorId: row.id,
									orgId: row.orgId,
									cause: error.message,
								}),
								Effect.as([]),
							),
						),
					),
				).pipe(Effect.map(Arr.flatten))
				const rowsById = new Map(rows.map((row) => [row.id, row]))
				const now = yield* Clock.currentTimeMillis
				const states = Object.values(Arr.groupBy(reports, (report) => report.monitorId)).flatMap(
					(group) => {
						const row = rowsById.get(Arr.headNonEmpty(group).monitorId)
						if (row === undefined || row.kind === "heartbeat") return []
						// A report at or before the stored last check is a retry of one already applied.
						const after =
							row.lastCheckJson === null ? Number.NEGATIVE_INFINITY : row.lastCheckJson.at
						const fresh = Arr.sort(
							group.filter((report) => report.checkedAt > after),
							Order.mapInput(Order.Number, (report: UptimeCheckReport) => report.checkedAt),
						)
						const last = Arr.last(fresh)
						if (Option.isNone(last)) return []
						const folded = foldReports(row, fresh)
						return [
							{
								monitorId: row.id,
								orgId: row.orgId,
								status: folded.snapshot.status,
								consecutiveFailures: folded.snapshot.consecutiveFailures,
								consecutiveSuccesses: folded.snapshot.consecutiveSuccesses,
								statusChangedAt: folded.statusChangedAt,
								lastCheckJson: toCheckDetail(last.value),
								recentJson: folded.recent,
								readUpdatedAt: row.stateUpdatedAt,
								updatedAt: now,
							},
						]
					},
				)
				if (states.length === 0) return 0
				const values = Orm.sql.join(
					states.map(
						(state) =>
							Orm.sql`(${state.monitorId}::text, ${state.status}::text, ${state.consecutiveFailures}::int4, ${state.consecutiveSuccesses}::int4, ${state.statusChangedAt === null ? null : msToSqlTimestamp(state.statusChangedAt)}::timestamptz, ${JSON.stringify(state.lastCheckJson)}::jsonb, ${JSON.stringify(state.recentJson)}::jsonb, ${msToSqlTimestamp(state.readUpdatedAt)}::timestamptz, ${msToSqlTimestamp(state.updatedAt)}::timestamptz)`,
					),
					Orm.sql`, `,
				)
				// One UPDATE for the batch: a monitor deleted, paused or resumed since the read no longer
				// matches its read `updated_at`, so stale results never overwrite the newer state.
				const updated = yield* dbExecute((db) =>
					db.query(
						Orm.sql`
							UPDATE uptime_monitor_states AS s SET
								status = v.status,
								consecutive_failures = v.consecutive_failures,
								consecutive_successes = v.consecutive_successes,
								status_changed_at = v.status_changed_at,
								last_check_json = v.last_check_json,
								recent_json = v.recent_json,
								updated_at = v.updated_at
							FROM (VALUES ${values}) AS v(monitor_id, status, consecutive_failures, consecutive_successes, status_changed_at, last_check_json, recent_json, read_updated_at, updated_at)
							WHERE s.monitor_id = v.monitor_id
								AND date_trunc('milliseconds', s.updated_at) = v.read_updated_at
								AND s.status <> 'paused'
							RETURNING s.monitor_id`,
						UpdatedStateRow,
					),
				)
				return updated.length
			})

			// Heartbeats are a public hot path: no spans of its own beyond the two queries.
			const applyPing = Effect.fnUntraced(function* (token: string, ok: boolean) {
				const rows = yield* dbExecute((db) =>
					db.run(
						selectMonitors()
							.where(($) => [$.heartbeatToken.eq(token)])
							.limit(1),
					),
				)
				const row = rows[0]
				if (row === undefined || !row.enabled || row.kind !== "heartbeat") {
					return yield* new UptimeHeartbeatNotFound({ message: "No such heartbeat" })
				}
				const now = yield* Clock.currentTimeMillis
				const status: UptimeMonitorStatus = ok ? "up" : "down"
				const written = yield* dbExecute((db) =>
					db.run(
						PG.update(UptimeMonitorStates)
							.set({
								status,
								consecutiveFailures: ok ? 0 : row.consecutiveFailures + 1,
								consecutiveSuccesses: ok ? row.consecutiveSuccesses + 1 : 0,
								statusChangedAt: status === row.status ? row.statusChangedAt : now,
								lastCheckJson: {
									at: now,
									ok,
									durationMs: null,
									statusCode: null,
									error: ok ? null : "The job reported a failure",
									traceId: null,
								},
								recentJson: appendRecentCheck(row.recentJson, {
									at: now,
									ok,
									durationMs: null,
								}),
								lastPingAt: now,
								updatedAt: now,
							})
							// Fenced on the state read: a ping or pause in between changes the counters or
							// `updated_at`, and this ping is read and applied again instead of overwriting it.
							.where(($) => [
								$.orgId.eq(row.orgId),
								$.monitorId.eq(row.id),
								$.updatedAt.eq(row.stateUpdatedAt),
								$.consecutiveFailures.eq(row.consecutiveFailures),
								$.consecutiveSuccesses.eq(row.consecutiveSuccesses),
								$.status.neq("paused"),
							])
							.returning("monitorId"),
					),
				)
				if (written.length === 0) {
					return yield* new UptimeHeartbeatPingConflict({
						message: "The heartbeat changed during the ping",
					})
				}
			})

			const recordPing = (token: string, ok: boolean) =>
				applyPing(token, ok).pipe(
					Effect.retry({
						times: PING_CONFLICT_RETRIES,
						while: (error) => error._tag === "@maple/backend/uptime/HeartbeatPingConflict",
					}),
					Effect.catchTag("@maple/backend/uptime/HeartbeatPingConflict", (error) =>
						Effect.fail(
							new UptimeMonitorPersistenceError({ message: error.message, cause: error }),
						),
					),
				)

			const testHttp = Effect.fn("UptimeMonitorsService.testHttp")(function* (
				raw: UptimeMonitorConfig,
			) {
				if (raw._tag !== "http") {
					return yield* invalid(
						`Only HTTP checks can be tested before saving; a ${raw._tag} monitor runs after it is created`,
					)
				}
				const config = yield* validateConfig("http", raw)
				if (config._tag !== "http")
					return yield* invalid("Only HTTP checks can be tested before saving")
				// The same request and verdict as the scraper's probe, minus the trace header.
				const outgoing = uptimeHttpRequest(config)
				const request = HttpClientRequest.make(outgoing.method)(outgoing.url, {
					headers: outgoing.headers,
				})
				const started = yield* Clock.currentTimeMillis
				const outcome: TestOutcome = yield* testClient
					.execute(
						outgoing.body === null
							? request
							: HttpClientRequest.bodyText(
									request,
									outgoing.body.text,
									outgoing.body.contentType,
								),
					)
					.pipe(
						Effect.flatMap((response) =>
							Effect.gen(function* () {
								const durationMs = (yield* Clock.currentTimeMillis) - started
								const body =
									config.method === "HEAD"
										? Option.none<{
												readonly text: string
												readonly truncated: boolean
											}>()
										: Option.some(yield* readTextPrefix(response, TEST_BODY_READ_BYTES))
								return {
									_tag: "response" as const,
									statusCode: response.status,
									durationMs,
									headers: Object.fromEntries(Object.entries(response.headers)),
									body: Option.match(body, {
										onNone: () => null,
										onSome: (read) => read.text,
									}),
									truncated: Option.match(body, {
										onNone: () => false,
										onSome: (read) => read.truncated,
									}),
								}
							}),
						),
						Effect.timeout(config.timeoutMs),
						Effect.scoped,
						Effect.catchTags({
							"@maple/safe-fetch/UrlValidationError": (error) =>
								Effect.succeed({ _tag: "failed" as const, error: error.message }),
							HttpClientError: (error) =>
								Effect.succeed({
									_tag: "failed" as const,
									error: describeHttpClientError(error),
								}),
							TimeoutError: () =>
								Effect.succeed({
									_tag: "failed" as const,
									error: `No response within ${config.timeoutMs} ms`,
								}),
						}),
					)
				// Workers can't dial a loopback or private origin; Cloudflare answers that (and an
				// unresolvable name) itself with a bare 530 "error code: 1016" instead of failing.
				const unreachable =
					outcome._tag === "response" &&
					outcome.statusCode === 530 &&
					outcome.body?.trim() === "error code: 1016"
				if (outcome._tag === "failed" || unreachable) {
					return {
						ok: false,
						statusCode: null,
						durationMs: (yield* Clock.currentTimeMillis) - started,
						failedAssertion: null,
						error:
							outcome._tag === "failed"
								? outcome.error
								: `Couldn't reach ${new URL(config.url).hostname}: it doesn't resolve to a public address`,
						headers: {},
						bodyPrefix: null,
						bodyTruncated: false,
					} satisfies UptimeHttpTestResult
				}
				const failedAssertion = firstFailedAssertion(effectiveAssertions(config.assertions), outcome)
				return {
					ok: failedAssertion === null,
					statusCode: outcome.statusCode,
					durationMs: outcome.durationMs,
					failedAssertion,
					error: null,
					headers: outcome.headers,
					bodyPrefix: outcome.body === null ? null : outcome.body.slice(0, TEST_BODY_PREFIX_CHARS),
					bodyTruncated:
						outcome.truncated ||
						(outcome.body !== null && outcome.body.length > TEST_BODY_PREFIX_CHARS),
				} satisfies UptimeHttpTestResult
			})

			return {
				list,
				get,
				create,
				update,
				delete: remove,
				listProbeTargets,
				recordChecks,
				recordPing,
				testHttp,
			} satisfies UptimeMonitorsServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(UptimeMonitorAllowance.layer))
}
