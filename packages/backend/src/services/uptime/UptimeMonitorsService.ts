// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import { randomBytes, randomUUID } from "node:crypto"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	UptimeMonitorStates,
	UptimeMonitors,
	type UptimeMonitorRow,
	type UptimeMonitorStateRow,
} from "@maple/db/tables"
import {
	UptimeMonitorLimitReachedError,
	UptimeMonitorNotFoundError,
	UptimeMonitorPersistenceError,
	UptimeMonitorValidationError,
} from "@maple/domain/http"
import {
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
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { msToSqlTimestamp } from "@maple/backend/platform/time"
import { Env } from "@maple/backend/platform/Env"
import { UptimeMonitorAllowance } from "./UptimeMonitorAllowance"

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
	readonly createdBy: UserId
}

export interface UpdateUptimeMonitorInput {
	readonly name?: string
	readonly config?: UptimeMonitorConfig
	readonly intervalSeconds?: UptimeIntervalSeconds
	readonly failuresToDown?: number
	readonly serviceName?: string | null
	readonly enabled?: boolean
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
	| "heartbeatToken"
	| "enabled"
	| "createdAt"
	| "updatedAt"
> &
	Pick<
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
		.select(($) => ({
			id: $.id,
			orgId: $.orgId,
			name: $.name,
			kind: $.kind,
			configJson: $.configJson,
			intervalSeconds: $.intervalSeconds,
			failuresToDown: $.failuresToDown,
			serviceName: $.serviceName,
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
				decodeInterval(row.intervalSeconds).pipe(
					Effect.mapError(
						(error) =>
							new UptimeMonitorPersistenceError({
								message: `Stored interval of uptime monitor ${row.id} is invalid`,
								cause: error,
							}),
					),
					Effect.map((intervalSeconds): UptimeMonitorRecord => ({
						id: row.id,
						orgId: row.orgId,
						name: row.name,
						kind: row.kind,
						config: row.configJson,
						intervalSeconds,
						failuresToDown: row.failuresToDown,
						serviceName: row.serviceName,
						enabled: row.enabled,
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
				const existing = yield* dbExecute((db) =>
					db.run(
						PG.from(UptimeMonitors)
							.select("id")
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)
				yield* allowance.ensureCanCreate(orgId, existing.length)

				const now = yield* Clock.currentTimeMillis
				const id = UptimeMonitorId.make(randomUUID())
				const enabled = input.enabled !== false
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.run(
								PG.insertInto(UptimeMonitors).values({
									id,
									orgId,
									name,
									kind: config._tag,
									configJson: config,
									intervalSeconds: input.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
									failuresToDown,
									serviceName: input.serviceName ?? null,
									alertRuleId: null,
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
						}),
					),
				)
				yield* allowance.track(orgId, id, 1)
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
				const enabledChange =
					input.enabled !== undefined && input.enabled !== current.enabled
						? Option.some(input.enabled)
						: Option.none<boolean>()
				const now = yield* Clock.currentTimeMillis
				const settingsChanged =
					config !== undefined ||
					input.intervalSeconds !== undefined ||
					failuresToDown !== undefined

				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.run(
								PG.update(UptimeMonitors)
									.set({
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
				const deleted = yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(UptimeMonitors)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(monitorId)])
							.returning("id"),
					),
				)
				if (deleted.length === 0) return yield* notFound(monitorId)
				yield* allowance.track(orgId, monitorId, -1)
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
				if (outcome._tag === "failed") {
					return {
						ok: false,
						statusCode: null,
						durationMs: (yield* Clock.currentTimeMillis) - started,
						failedAssertion: null,
						error: outcome.error,
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
