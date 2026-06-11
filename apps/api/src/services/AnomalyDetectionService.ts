import { randomUUID } from "node:crypto"
import {
	AnomalyDetectorSettingsDocument,
	type AnomalyDetectorSettingsUpdateRequest,
	AnomalyIncidentDocument,
	AnomalyIncidentNotFoundError,
	AnomalyIncidentsListResponse,
	type AnomalyIncidentId,
	type AnomalyIncidentStatus,
	AnomalyPersistenceError,
	type AnomalySensitivity,
	type AnomalySignalType,
	type OrgId,
	RoleName,
	type UserId,
	UserId as UserIdSchema,
} from "@maple/domain/http"
import {
	anomalyDetectorSettings,
	type AnomalyDetectorSettingsRow,
	anomalyDetectorStates,
	type AnomalyDetectorStateRow,
	anomalyIncidents,
	type AnomalyIncidentRow,
	errorIssues,
	orgIngestKeys,
} from "@maple/db"
import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm"
import { CH, parseWarehouseDateTime } from "@maple/query-engine"
import { EdgeCacheService } from "@maple/query-engine/caching"
import { Cause, Clock, Context, Effect, Layer, Option, Schedule, Schema } from "effect"
import type { TenantContext } from "./AuthService"
import { AI_TRIAGE_WORKFLOW_BINDING, maybeEnqueueTriage } from "../lib/ai-triage-enqueue"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Database, DatabaseError, type DatabaseClient } from "../lib/DatabaseLive"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import {
	evaluateErrorSpike,
	evaluateGoldenSignals,
	evaluateLogVolume,
	SENSITIVITY,
	type AnomalyEvaluation,
	type ErrorSpikeBaseline,
	type GoldenSignalSeries,
	type LogVolumeSeries,
} from "./anomaly/detection"
import {
	decideTransition,
	DEFAULT_STATE_MACHINE_CONFIG,
	type DetectorStateSnapshot,
} from "./anomaly/state-machine"

const decodeIncidentIdSync = Schema.decodeUnknownSync(AnomalyIncidentDocument.fields.id)
const decodeIsoSync = Schema.decodeUnknownSync(AnomalyIncidentDocument.fields.firstTriggeredAt)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)

const HOUR_MS = 60 * 60 * 1000
const BASELINE_WINDOW_MS = 7 * 24 * HOUR_MS
const SPIKE_WINDOW_MS = 30 * 60 * 1000
/** Org-level claim lock TTL — slightly under the 5-minute tick cadence. */
const ORG_LOCK_TTL_MS = 4 * 60 * 1000
const NO_DATA_RESOLVE_MS = 60 * 60 * 1000
const MAX_OPENS_PER_TICK = 10
/** Cap evaluated golden-signal/log series to the busiest N per org. */
const MAX_SERIES_PER_ORG = 200
const STATE_RETENTION_MS = 14 * 24 * HOUR_MS
const RETENTION_PHASE_EVERY_N_TICKS = 36
const TICK_CADENCE_MS = 5 * 60 * 1000
const ERROR_SPIKE_BASELINE_CACHE_BUCKET = "anomaly-errbase"

const describeCause = (cause: unknown): string | undefined => {
	if (cause == null) return undefined
	if (cause instanceof Error) return cause.stack ?? cause.message
	if (typeof cause === "string") return cause
	try {
		return JSON.stringify(cause)
	} catch {
		return String(cause)
	}
}

const makePersistenceError = (error: unknown): AnomalyPersistenceError => {
	const message =
		error instanceof DatabaseError || error instanceof Error
			? error.message
			: "Anomaly persistence failure"
	const cause = describeCause(error instanceof Error ? error.cause : error)
	return cause === undefined
		? new AnomalyPersistenceError({ message })
		: new AnomalyPersistenceError({ message, cause })
}

const BUSY_ERROR_PATTERN = /SQLITE_BUSY|database is locked|D1_BUSY|busy/i

const isBusyDatabaseError = (error: DatabaseError): boolean => {
	if (BUSY_ERROR_PATTERN.test(error.message)) return true
	const inner = error.cause instanceof Error ? error.cause.message : undefined
	return inner !== undefined && BUSY_ERROR_PATTERN.test(inner)
}

const BUSY_RETRY_SCHEDULE = Schedule.exponential("50 millis", 2.0).pipe(
	Schedule.both(Schedule.recurs(3)),
)

interface ErrorSpikeBaselineEntry extends ErrorSpikeBaseline {
	readonly fingerprintHash: string
	readonly deploymentEnv: string
}

export interface AnomalyTickResult {
	readonly orgsProcessed: number
	readonly seriesEvaluated: number
	readonly incidentsOpened: number
	readonly incidentsContinued: number
	readonly incidentsResolved: number
	readonly orgFailures: number
}

export interface AnomalyDetectionServiceShape {
	readonly runTick: () => Effect.Effect<AnomalyTickResult, AnomalyPersistenceError>
	readonly listIncidents: (
		orgId: OrgId,
		opts: {
			readonly status?: AnomalyIncidentStatus
			readonly signalType?: AnomalySignalType
			readonly service?: string
			readonly deploymentEnv?: string
			readonly startTime?: string
			readonly endTime?: string
			readonly limit?: number
		},
	) => Effect.Effect<AnomalyIncidentsListResponse, AnomalyPersistenceError>
	readonly getIncident: (
		orgId: OrgId,
		incidentId: AnomalyIncidentId,
	) => Effect.Effect<AnomalyIncidentDocument, AnomalyPersistenceError | AnomalyIncidentNotFoundError>
	readonly getSettings: (
		orgId: OrgId,
	) => Effect.Effect<AnomalyDetectorSettingsDocument, AnomalyPersistenceError>
	readonly updateSettings: (
		orgId: OrgId,
		userId: UserId,
		request: AnomalyDetectorSettingsUpdateRequest,
	) => Effect.Effect<AnomalyDetectorSettingsDocument, AnomalyPersistenceError>
}

export class AnomalyDetectionService extends Context.Service<
	AnomalyDetectionService,
	AnomalyDetectionServiceShape
>()("@maple/api/services/AnomalyDetectionService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService
		const edgeCache = yield* EdgeCacheService
		// Optional: present only inside a Worker isolate. Used to kick off the
		// AI triage Workflow when an incident opens (org opt-in).
		const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)
		const aiTriageWorkflowBinding = Option.match(workerEnv, {
			onNone: () => undefined,
			onSome: (e) => e[AI_TRIAGE_WORKFLOW_BINDING],
		})

		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			database.execute(fn).pipe(
				Effect.retry({
					schedule: BUSY_RETRY_SCHEDULE,
					while: isBusyDatabaseError,
				}),
				Effect.tapError((error) =>
					Effect.logError("AnomalyDetectionService dbExecute failed").pipe(
						Effect.annotateLogs({
							message: error.message,
							cause: describeCause(error.cause) ?? "(none)",
						}),
					),
				),
				Effect.mapError(makePersistenceError),
			)

		const toTinybirdDateTime = (epochMs: number) =>
			new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")

		const isoFromEpoch = (ms: number) => decodeIsoSync(new Date(ms).toISOString())

		const systemTenant = (orgId: OrgId): TenantContext => ({
			orgId,
			userId: decodeUserIdSync("system-anomaly"),
			roles: [decodeRoleNameSync("root")],
			authMode: "self_hosted",
		})

		// -----------------------------------------------------------------
		// Settings
		// -----------------------------------------------------------------

		const parseMutedSignals = (raw: string): ReadonlyArray<AnomalySignalType> => {
			try {
				const parsed = JSON.parse(raw)
				if (!Array.isArray(parsed)) return []
				return parsed.filter(
					(v): v is AnomalySignalType =>
						v === "error_rate" ||
						v === "latency_p95" ||
						v === "throughput" ||
						v === "error_spike" ||
						v === "log_volume",
				)
			} catch {
				return []
			}
		}

		const settingsToDocument = (row: AnomalyDetectorSettingsRow): AnomalyDetectorSettingsDocument =>
			new AnomalyDetectorSettingsDocument({
				enabled: row.enabled === 1,
				sensitivity: row.sensitivity,
				mutedSignals: parseMutedSignals(row.mutedSignalsJson),
				updatedAt: row.updatedAt ? isoFromEpoch(row.updatedAt) : null,
				updatedBy: row.updatedBy ?? null,
			})

		const loadSettingsRow = Effect.fn("AnomalyDetectionService.loadSettingsRow")(function* (
			orgId: OrgId,
		) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(anomalyDetectorSettings)
					.where(eq(anomalyDetectorSettings.orgId, orgId))
					.limit(1),
			)
			return rows[0]
		})

		const ensureSettingsRow = Effect.fn("AnomalyDetectionService.ensureSettingsRow")(function* (
			orgId: OrgId,
			nowMs: number,
		) {
			const existing = yield* loadSettingsRow(orgId)
			if (existing) return existing
			yield* dbExecute((db) =>
				db
					.insert(anomalyDetectorSettings)
					.values({
						orgId,
						enabled: 1,
						sensitivity: "normal",
						mutedSignalsJson: "[]",
						createdAt: nowMs,
						updatedAt: nowMs,
					})
					.onConflictDoNothing(),
			)
			const refreshed = yield* loadSettingsRow(orgId)
			if (!refreshed) {
				return yield* Effect.fail(
					new AnomalyPersistenceError({ message: "Failed to create anomaly settings row" }),
				)
			}
			return refreshed
		})

		const getSettings: AnomalyDetectionServiceShape["getSettings"] = Effect.fn(
			"AnomalyDetectionService.getSettings",
		)(function* (orgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const nowMs = yield* Clock.currentTimeMillis
			const row = yield* ensureSettingsRow(orgId, nowMs)
			return settingsToDocument(row)
		})

		const updateSettings: AnomalyDetectionServiceShape["updateSettings"] = Effect.fn(
			"AnomalyDetectionService.updateSettings",
		)(function* (orgId, userId, request) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const nowMs = yield* Clock.currentTimeMillis
			const existing = yield* ensureSettingsRow(orgId, nowMs)
			const next = {
				enabled:
					request.enabled === undefined ? existing.enabled : request.enabled ? 1 : 0,
				sensitivity: (request.sensitivity ?? existing.sensitivity) as AnomalySensitivity,
				mutedSignalsJson:
					request.mutedSignals === undefined
						? existing.mutedSignalsJson
						: JSON.stringify(request.mutedSignals),
				updatedAt: nowMs,
				updatedBy: userId,
			}
			yield* dbExecute((db) =>
				db.update(anomalyDetectorSettings).set(next).where(eq(anomalyDetectorSettings.orgId, orgId)),
			)
			const refreshed = yield* loadSettingsRow(orgId)
			return settingsToDocument(refreshed ?? { ...existing, ...next })
		})

		// -----------------------------------------------------------------
		// Incident reads
		// -----------------------------------------------------------------

		const incidentToDocument = (row: AnomalyIncidentRow): AnomalyIncidentDocument =>
			new AnomalyIncidentDocument({
				id: decodeIncidentIdSync(row.id),
				detectorKey: row.detectorKey,
				signalType: row.signalType,
				serviceName: row.serviceName,
				deploymentEnv: row.deploymentEnv,
				fingerprintHash: row.fingerprintHash ?? null,
				errorIssueId: row.errorIssueId ?? null,
				status: row.status,
				severity: row.severity,
				openedValue: row.openedValue,
				baselineMedian: row.baselineMedian,
				baselineSigma: row.baselineSigma,
				thresholdValue: row.thresholdValue,
				lastObservedValue: row.lastObservedValue,
				lastSampleCount: row.lastSampleCount,
				firstTriggeredAt: isoFromEpoch(row.firstTriggeredAt),
				lastTriggeredAt: isoFromEpoch(row.lastTriggeredAt),
				resolvedAt: row.resolvedAt ? isoFromEpoch(row.resolvedAt) : null,
				resolveReason: row.resolveReason ?? null,
				triageStatus: row.triageStatus,
			})

		const listIncidents: AnomalyDetectionServiceShape["listIncidents"] = Effect.fn(
			"AnomalyDetectionService.listIncidents",
		)(function* (orgId, opts) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const conditions = [
				eq(anomalyIncidents.orgId, orgId),
				opts.status ? eq(anomalyIncidents.status, opts.status) : undefined,
				opts.signalType ? eq(anomalyIncidents.signalType, opts.signalType) : undefined,
				opts.service ? eq(anomalyIncidents.serviceName, opts.service) : undefined,
				opts.deploymentEnv ? eq(anomalyIncidents.deploymentEnv, opts.deploymentEnv) : undefined,
				opts.startTime
					? gte(anomalyIncidents.lastTriggeredAt, Date.parse(opts.startTime))
					: undefined,
				opts.endTime ? lte(anomalyIncidents.firstTriggeredAt, Date.parse(opts.endTime)) : undefined,
			].filter((c): c is NonNullable<typeof c> => c !== undefined)
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(anomalyIncidents)
					.where(and(...conditions))
					.orderBy(desc(anomalyIncidents.lastTriggeredAt))
					.limit(opts.limit ?? 100),
			)
			return new AnomalyIncidentsListResponse({ incidents: rows.map(incidentToDocument) })
		})

		const getIncident: AnomalyDetectionServiceShape["getIncident"] = Effect.fn(
			"AnomalyDetectionService.getIncident",
		)(function* (orgId, incidentId) {
			yield* Effect.annotateCurrentSpan({ orgId, incidentId })
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(anomalyIncidents)
					.where(and(eq(anomalyIncidents.orgId, orgId), eq(anomalyIncidents.id, incidentId)))
					.limit(1),
			)
			const row = rows[0]
			if (!row) {
				return yield* Effect.fail(
					new AnomalyIncidentNotFoundError({
						message: `No such anomaly incident: '${incidentId}'`,
						incidentId,
					}),
				)
			}
			return incidentToDocument(row)
		})

		// -----------------------------------------------------------------
		// Tick: data fetch
		// -----------------------------------------------------------------

		interface HourRow {
			readonly hour: string
			readonly serviceName: string
			readonly deploymentEnv: string
		}

		/** Split matched-hour rows into the in-progress hour vs sealed baseline. */
		const splitRows = <R extends HourRow>(rows: ReadonlyArray<R>, currentHourStartMs: number) => {
			const current = new Map<string, R>()
			const baseline = new Map<string, R[]>()
			for (const row of rows) {
				const key = `${row.serviceName}\u0000${row.deploymentEnv}`
				if (parseWarehouseDateTime(row.hour) >= currentHourStartMs) {
					current.set(key, row)
				} else {
					const list = baseline.get(key)
					if (list) list.push(row)
					else baseline.set(key, [row])
				}
			}
			return { current, baseline }
		}

		const fetchGoldenSeries = Effect.fn("AnomalyDetectionService.fetchGoldenSeries")(function* (
			tenant: TenantContext,
			nowMs: number,
			currentHourStartMs: number,
		) {
			const compiled = CH.compile(
				CH.anomalyTraceSignalsQuery({
					hoursOfDay: CH.matchedHoursOfDay(new Date(nowMs).getUTCHours()),
				}),
				{
					orgId: tenant.orgId,
					startTime: toTinybirdDateTime(nowMs - BASELINE_WINDOW_MS),
					endTime: toTinybirdDateTime(nowMs),
				},
			)
			const rows = yield* warehouse
				.compiledQuery(tenant, compiled, { profile: "list", context: "anomalyTraceSignals" })
				.pipe(Effect.mapError(makePersistenceError))
			const normalized = rows.map((r) => ({
				hour: String(r.hour ?? ""),
				serviceName: String(r.serviceName ?? ""),
				deploymentEnv: String(r.deploymentEnv ?? ""),
				requestCount: Number(r.requestCount ?? 0),
				errorCount: Number(r.errorCount ?? 0),
				p95Ms: Number(r.p95Ms ?? 0),
			}))
			const { current, baseline } = splitRows(normalized, currentHourStartMs)

			const keys = new Set([...current.keys(), ...baseline.keys()])
			const series: GoldenSignalSeries[] = []
			for (const key of keys) {
				const [serviceName = "", deploymentEnv = ""] = key.split("\u0000")
				const cur = current.get(key)
				series.push({
					serviceName,
					deploymentEnv,
					current: {
						requestCount: cur?.requestCount ?? 0,
						errorCount: cur?.errorCount ?? 0,
						p95Ms: cur?.p95Ms ?? 0,
					},
					baseline: baseline.get(key) ?? [],
				})
			}
			// Bound per-org work to the busiest series.
			return series
				.sort(
					(a, b) =>
						Math.max(b.current.requestCount, b.baseline.length) -
						Math.max(a.current.requestCount, a.baseline.length),
				)
				.slice(0, MAX_SERIES_PER_ORG)
		})

		const fetchLogSeries = Effect.fn("AnomalyDetectionService.fetchLogSeries")(function* (
			tenant: TenantContext,
			nowMs: number,
			currentHourStartMs: number,
		) {
			const compiled = CH.compile(
				CH.anomalyLogVolumeQuery({
					hoursOfDay: CH.matchedHoursOfDay(new Date(nowMs).getUTCHours()),
				}),
				{
					orgId: tenant.orgId,
					startTime: toTinybirdDateTime(nowMs - BASELINE_WINDOW_MS),
					endTime: toTinybirdDateTime(nowMs),
				},
			)
			const rows = yield* warehouse
				.compiledQuery(tenant, compiled, { profile: "list", context: "anomalyLogVolume" })
				.pipe(Effect.mapError(makePersistenceError))
			const normalized = rows.map((r) => ({
				hour: String(r.hour ?? ""),
				serviceName: String(r.serviceName ?? ""),
				deploymentEnv: String(r.deploymentEnv ?? ""),
				errorLogCount: Number(r.errorLogCount ?? 0),
			}))
			const { current, baseline } = splitRows(normalized, currentHourStartMs)
			const keys = new Set([...current.keys(), ...baseline.keys()])
			const series: LogVolumeSeries[] = []
			for (const key of keys) {
				const [serviceName = "", deploymentEnv = ""] = key.split("\u0000")
				series.push({
					serviceName,
					deploymentEnv,
					current: { errorLogCount: current.get(key)?.errorLogCount ?? 0 },
					baseline: baseline.get(key) ?? [],
				})
			}
			return series.slice(0, MAX_SERIES_PER_ORG)
		})

		const fetchErrorSpikes = Effect.fn("AnomalyDetectionService.fetchErrorSpikes")(function* (
			tenant: TenantContext,
			nowMs: number,
		) {
			const currentCompiled = CH.compile(CH.anomalyErrorSpikeCurrentQuery({}), {
				orgId: tenant.orgId,
				startTime: toTinybirdDateTime(nowMs - SPIKE_WINDOW_MS),
				endTime: toTinybirdDateTime(nowMs),
			})
			const currentRows = yield* warehouse
				.compiledQuery(tenant, currentCompiled, {
					profile: "list",
					context: "anomalyErrorSpikeCurrent",
				})
				.pipe(Effect.mapError(makePersistenceError))

			const observations = currentRows.map((r) => ({
				fingerprintHash: String(r.fingerprintHash ?? ""),
				serviceName: String(r.serviceName ?? ""),
				deploymentEnv: String(r.deploymentEnv ?? ""),
				count: Number(r.count ?? 0),
			}))

			if (observations.length === 0) {
				return { observations, baselines: new Map<string, ErrorSpikeBaselineEntry>() }
			}

			// The 7d baseline blob is expensive relative to the tick cadence, so it
			// is computed once per hour per org and shared from KV (one query, one
			// blob — deliberately NOT the bucket cache, which fans out).
			const hourBucket = Math.floor(nowMs / HOUR_MS)
			const { value: baselineRows } = yield* edgeCache.getOrCompute(
				{
					bucket: ERROR_SPIKE_BASELINE_CACHE_BUCKET,
					key: `${tenant.orgId}:${hourBucket}`,
					ttlSeconds: 3600,
				},
				Effect.gen(function* () {
					const baselineCompiled = CH.compile(CH.anomalyErrorSpikeBaselineQuery({}), {
						orgId: tenant.orgId,
						startTime: toTinybirdDateTime(nowMs - BASELINE_WINDOW_MS),
						endTime: toTinybirdDateTime(Math.floor(nowMs / HOUR_MS) * HOUR_MS),
					})
					const rows = yield* warehouse
						.compiledQuery(tenant, baselineCompiled, {
							profile: "list",
							context: "anomalyErrorSpikeBaseline",
						})
						.pipe(Effect.mapError(makePersistenceError))
					return rows.map(
						(r): ErrorSpikeBaselineEntry => ({
							fingerprintHash: String(r.fingerprintHash ?? ""),
							deploymentEnv: String(r.deploymentEnv ?? ""),
							totalCount: Number(r.totalCount ?? 0),
						}),
					)
				}),
			)

			const baselines = new Map<string, ErrorSpikeBaselineEntry>()
			for (const row of baselineRows) {
				baselines.set(`${row.fingerprintHash}\u0000${row.deploymentEnv}`, row)
			}
			return { observations, baselines }
		})

		// -----------------------------------------------------------------
		// Tick: per-org processing
		// -----------------------------------------------------------------

		const claimOrg = (orgId: OrgId, nowMs: number) =>
			dbExecute((db) =>
				db
					.update(anomalyDetectorSettings)
					.set({ lastTickAt: nowMs })
					.where(
						and(
							eq(anomalyDetectorSettings.orgId, orgId),
							sql`(${anomalyDetectorSettings.lastTickAt} IS NULL OR ${anomalyDetectorSettings.lastTickAt} < ${nowMs - ORG_LOCK_TTL_MS})`,
						),
					),
			)

		const newIncidentId = () => decodeIncidentIdSync(randomUUID())

		interface OrgTickStats {
			seriesEvaluated: number
			incidentsOpened: number
			incidentsContinued: number
			incidentsResolved: number
		}

		const processOrg = Effect.fn("AnomalyDetectionService.processOrg")(function* (
			orgId: OrgId,
			nowMs: number,
			runRetention: boolean,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, runRetention })
			const stats: OrgTickStats = {
				seriesEvaluated: 0,
				incidentsOpened: 0,
				incidentsContinued: 0,
				incidentsResolved: 0,
			}

			const settings = yield* ensureSettingsRow(orgId, nowMs)
			if (settings.enabled !== 1) return stats

			const claim = yield* claimOrg(orgId, nowMs)
			if ((claim as { rowsAffected?: number }).rowsAffected === 0) return stats

			const muted = new Set(parseMutedSignals(settings.mutedSignalsJson))
			const sensitivity = SENSITIVITY[settings.sensitivity] ?? SENSITIVITY.normal
			const tenant = systemTenant(orgId)
			const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
			const elapsedMinutes = Math.floor((nowMs - currentHourStartMs) / 60_000)
			const config = { sensitivity, elapsedMinutes }

			const [goldenSeries, logSeries, spikes] = yield* Effect.all(
				[
					fetchGoldenSeries(tenant, nowMs, currentHourStartMs),
					fetchLogSeries(tenant, nowMs, currentHourStartMs),
					fetchErrorSpikes(tenant, nowMs),
				],
				{ concurrency: 3 },
			)

			// firstSeenAt per fingerprint so young issues stay with first_seen handling.
			const fingerprints = [...new Set(spikes.observations.map((o) => o.fingerprintHash))]
			const issueRows =
				fingerprints.length > 0
					? yield* dbExecute((db) =>
							db
								.select({
									fingerprintHash: errorIssues.fingerprintHash,
									issueId: errorIssues.id,
									firstSeenAt: errorIssues.firstSeenAt,
								})
								.from(errorIssues)
								.where(
									and(
										eq(errorIssues.orgId, orgId),
										inArray(errorIssues.fingerprintHash, fingerprints.slice(0, 500)),
									),
								),
						)
					: []
			const issueFirstSeenAt = new Map(issueRows.map((r) => [r.fingerprintHash, r.firstSeenAt]))
			const issueIdByFingerprint = new Map(issueRows.map((r) => [r.fingerprintHash, r.issueId]))

			const evaluations: AnomalyEvaluation[] = []
			for (const series of goldenSeries) {
				evaluations.push(...evaluateGoldenSignals(series, config))
			}
			for (const series of logSeries) {
				evaluations.push(evaluateLogVolume(series, config))
			}
			const spikeConfig = { sensitivity, issueFirstSeenAt, nowMs }
			for (const observation of spikes.observations) {
				const baseline = spikes.baselines.get(
					`${observation.fingerprintHash}\u0000${observation.deploymentEnv}`,
				)
				evaluations.push(evaluateErrorSpike(observation, baseline, spikeConfig))
			}

			const active = evaluations.filter((e) => !muted.has(e.signalType))
			stats.seriesEvaluated = active.length

			// Load all detector states + open incidents for the org in two reads.
			const stateRows = yield* dbExecute((db) =>
				db.select().from(anomalyDetectorStates).where(eq(anomalyDetectorStates.orgId, orgId)),
			)
			const stateByKey = new Map<string, AnomalyDetectorStateRow>(
				stateRows.map((r) => [r.detectorKey, r]),
			)

			interface PendingDecision {
				readonly evaluation: AnomalyEvaluation
				readonly state: AnomalyDetectorStateRow | undefined
				readonly transition: "open" | "continue" | "resolve" | "noop"
				readonly consecutiveBreaches: number
				readonly consecutiveHealthy: number
			}

			const decisions: PendingDecision[] = active.map((evaluation) => {
				const state = stateByKey.get(evaluation.detectorKey)
				const snapshot: DetectorStateSnapshot = {
					consecutiveBreaches: state?.consecutiveBreaches ?? 0,
					consecutiveHealthy: state?.consecutiveHealthy ?? 0,
					openIncidentId: state?.openIncidentId ?? null,
					lastResolvedAt: state?.lastResolvedAt ?? null,
				}
				const decision = decideTransition(snapshot, evaluation, DEFAULT_STATE_MACHINE_CONFIG, nowMs)
				return { evaluation, state, ...decision }
			})

			// Page-storm guard: cap newly opened incidents per tick; the rest keep
			// their breach counters and open on a later tick if still anomalous.
			const openDecisions = decisions
				.filter((d) => d.transition === "open")
				.sort((a, b) => {
					if (a.evaluation.severity !== b.evaluation.severity) {
						return a.evaluation.severity === "critical" ? -1 : 1
					}
					const ratioA = a.evaluation.threshold > 0 ? a.evaluation.value / a.evaluation.threshold : 0
					const ratioB = b.evaluation.threshold > 0 ? b.evaluation.value / b.evaluation.threshold : 0
					return ratioB - ratioA
				})
			const allowedOpens = new Set(openDecisions.slice(0, MAX_OPENS_PER_TICK))

			for (const decision of decisions) {
				const { evaluation } = decision
				const transition =
					decision.transition === "open" && !allowedOpens.has(decision)
						? "noop"
						: decision.transition

				let openIncidentId = decision.state?.openIncidentId ?? null
				let lastResolvedAt = decision.state?.lastResolvedAt ?? null

				if (transition === "open") {
					const incidentId = newIncidentId()
					const errorIssueId =
						evaluation.fingerprintHash !== null
							? (issueIdByFingerprint.get(evaluation.fingerprintHash) ?? null)
							: null
					yield* dbExecute((db) =>
						db.insert(anomalyIncidents).values({
							id: incidentId,
							orgId,
							detectorKey: evaluation.detectorKey,
							signalType: evaluation.signalType,
							serviceName: evaluation.serviceName,
							deploymentEnv: evaluation.deploymentEnv,
							fingerprintHash: evaluation.fingerprintHash,
							errorIssueId,
							status: "open",
							severity: evaluation.severity,
							openedValue: evaluation.value,
							baselineMedian: evaluation.baselineMedian,
							baselineSigma: evaluation.baselineSigma,
							thresholdValue: evaluation.threshold,
							lastObservedValue: evaluation.value,
							lastSampleCount: evaluation.sampleCount,
							firstTriggeredAt: nowMs,
							lastTriggeredAt: nowMs,
							triageStatus: "none",
							dedupeKey: `${orgId}:${evaluation.detectorKey}`,
							createdAt: nowMs,
							updatedAt: nowMs,
						}),
					)
					openIncidentId = incidentId
					stats.incidentsOpened += 1

					// AI auto-triage (org opt-in). Never fails — a triage problem can't
					// take down the detector tick.
					const triage = yield* maybeEnqueueTriage({
						orgId,
						incidentKind: "anomaly",
						incidentId,
						issueId: errorIssueId ?? undefined,
						context: {
							kind: "anomaly",
							signalType: evaluation.signalType,
							serviceName: evaluation.serviceName,
							deploymentEnv: evaluation.deploymentEnv,
							fingerprintHash: evaluation.fingerprintHash,
							severity: evaluation.severity,
							observedValue: evaluation.value,
							baselineMedian: evaluation.baselineMedian,
							baselineSigma: evaluation.baselineSigma,
							thresholdValue: evaluation.threshold,
							sampleCount: evaluation.sampleCount,
							detectedAt: new Date(nowMs).toISOString(),
						},
						workflowBinding: aiTriageWorkflowBinding,
					}).pipe(Effect.provideService(Database, database))
					if (triage.enqueued) {
						yield* dbExecute((db) =>
							db
								.update(anomalyIncidents)
								.set({ triageStatus: "pending", updatedAt: nowMs })
								.where(
									and(eq(anomalyIncidents.orgId, orgId), eq(anomalyIncidents.id, incidentId)),
								),
						)
					}
				} else if (transition === "continue" && openIncidentId !== null) {
					const incidentId = openIncidentId
					yield* dbExecute((db) =>
						db
							.update(anomalyIncidents)
							.set({
								lastObservedValue: evaluation.value,
								lastSampleCount: evaluation.sampleCount,
								severity: evaluation.severity,
								lastTriggeredAt: nowMs,
								updatedAt: nowMs,
							})
							.where(and(eq(anomalyIncidents.orgId, orgId), eq(anomalyIncidents.id, incidentId))),
					)
					stats.incidentsContinued += 1
				} else if (transition === "resolve" && openIncidentId !== null) {
					const incidentId = openIncidentId
					yield* dbExecute((db) =>
						db
							.update(anomalyIncidents)
							.set({
								status: "resolved",
								resolveReason: "returned_to_baseline",
								resolvedAt: nowMs,
								updatedAt: nowMs,
							})
							.where(and(eq(anomalyIncidents.orgId, orgId), eq(anomalyIncidents.id, incidentId))),
					)
					openIncidentId = null
					lastResolvedAt = nowMs
					stats.incidentsResolved += 1
				}

				yield* dbExecute((db) =>
					db
						.insert(anomalyDetectorStates)
						.values({
							orgId,
							detectorKey: evaluation.detectorKey,
							signalType: evaluation.signalType,
							serviceName: evaluation.serviceName,
							deploymentEnv: evaluation.deploymentEnv,
							fingerprintHash: evaluation.fingerprintHash,
							consecutiveBreaches: decision.consecutiveBreaches,
							consecutiveHealthy: decision.consecutiveHealthy,
							lastStatus: evaluation.status,
							lastValue: evaluation.value,
							baselineMedian: evaluation.baselineMedian,
							lastSampleCount: evaluation.sampleCount,
							lastEvaluatedAt: nowMs,
							openIncidentId,
							lastResolvedAt,
							updatedAt: nowMs,
						})
						.onConflictDoUpdate({
							target: [anomalyDetectorStates.orgId, anomalyDetectorStates.detectorKey],
							set: {
								consecutiveBreaches: decision.consecutiveBreaches,
								consecutiveHealthy: decision.consecutiveHealthy,
								lastStatus: evaluation.status,
								lastValue: evaluation.value,
								baselineMedian: evaluation.baselineMedian,
								lastSampleCount: evaluation.sampleCount,
								lastEvaluatedAt: nowMs,
								openIncidentId,
								lastResolvedAt,
								updatedAt: nowMs,
							},
						}),
				)
			}

			// No-data sweep: open incidents whose series stopped reporting entirely
			// resolve after an hour of silence (mirrors ErrorsService auto-resolve).
			const staleIncidents = yield* dbExecute((db) =>
				db
					.select()
					.from(anomalyIncidents)
					.where(
						and(
							eq(anomalyIncidents.orgId, orgId),
							eq(anomalyIncidents.status, "open"),
							lt(anomalyIncidents.lastTriggeredAt, nowMs - NO_DATA_RESOLVE_MS),
						),
					),
			)
			for (const incident of staleIncidents) {
				yield* dbExecute((db) =>
					db
						.update(anomalyIncidents)
						.set({
							status: "resolved",
							resolveReason: "no_data",
							resolvedAt: nowMs,
							updatedAt: nowMs,
						})
						.where(and(eq(anomalyIncidents.orgId, orgId), eq(anomalyIncidents.id, incident.id))),
				)
				yield* dbExecute((db) =>
					db
						.update(anomalyDetectorStates)
						.set({
							openIncidentId: null,
							lastResolvedAt: nowMs,
							consecutiveBreaches: 0,
							consecutiveHealthy: 0,
							updatedAt: nowMs,
						})
						.where(
							and(
								eq(anomalyDetectorStates.orgId, orgId),
								eq(anomalyDetectorStates.detectorKey, incident.detectorKey),
							),
						),
				)
				stats.incidentsResolved += 1
			}

			if (runRetention) {
				yield* dbExecute((db) =>
					db
						.delete(anomalyDetectorStates)
						.where(
							and(
								eq(anomalyDetectorStates.orgId, orgId),
								lt(anomalyDetectorStates.lastEvaluatedAt, nowMs - STATE_RETENTION_MS),
							),
						),
				)
			}

			return stats
		})

		const runTick: AnomalyDetectionServiceShape["runTick"] = Effect.fn(
			"AnomalyDetectionService.runTick",
		)(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const runRetention =
				Math.floor(nowMs / TICK_CADENCE_MS) % RETENTION_PHASE_EVERY_N_TICKS === 0

			const ingestOrgs = yield* dbExecute((db) =>
				db.selectDistinct({ orgId: orgIngestKeys.orgId }).from(orgIngestKeys),
			)
			const settingsOrgs = yield* dbExecute((db) =>
				db.selectDistinct({ orgId: anomalyDetectorSettings.orgId }).from(anomalyDetectorSettings),
			)
			const knownOrgs = new Set<string>([
				...ingestOrgs.map((r) => r.orgId),
				...settingsOrgs.map((r) => r.orgId),
			])

			let orgFailures = 0
			const emptyStats = {
				seriesEvaluated: 0,
				incidentsOpened: 0,
				incidentsContinued: 0,
				incidentsResolved: 0,
			}
			const results = yield* Effect.forEach(
				[...knownOrgs],
				(org) =>
					processOrg(org as OrgId, nowMs, runRetention).pipe(
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								yield* Effect.logError("Anomaly tick failed for org").pipe(
									Effect.annotateLogs({ orgId: org, error: Cause.pretty(cause) }),
								)
								orgFailures += 1
								return emptyStats
							}),
						),
					),
				{ concurrency: 4 },
			)

			const totals = results.reduce(
				(acc, r) => ({
					seriesEvaluated: acc.seriesEvaluated + r.seriesEvaluated,
					incidentsOpened: acc.incidentsOpened + r.incidentsOpened,
					incidentsContinued: acc.incidentsContinued + r.incidentsContinued,
					incidentsResolved: acc.incidentsResolved + r.incidentsResolved,
				}),
				emptyStats,
			)

			yield* Effect.annotateCurrentSpan({ orgsKnown: knownOrgs.size, orgFailures, ...totals })

			return { orgsProcessed: knownOrgs.size, orgFailures, ...totals }
		})

		return {
			runTick,
			listIncidents,
			getIncident,
			getSettings,
			updateSettings,
		} satisfies AnomalyDetectionServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
