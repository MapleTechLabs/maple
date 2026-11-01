/**
 * The telemetry evidence section: the org's services, environments and SDKs,
 * alert evaluations and errors, the product events Maple's own app recorded
 * for it, and its audit-log activity, all from the warehouse over the 60 days
 * before the cancellation. Each part is read on its own and is `null` when it
 * cannot be.
 */
import type {
	CancellationAlertChecks,
	CancellationAuditActors,
	CancellationErrorVolume,
	CancellationProductEvent,
	CancellationResourceAttribute,
	CancellationResourceKey,
	CancellationServices,
	CancellationSignalVolume,
	CancellationTelemetryEvidence as TelemetryEvidence,
} from "@maple/domain/http"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { Cause, Context, DateTime, Effect, Layer } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { systemTenant } from "@maple/backend/services/alerts/system-tenant"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { type CancellationEvidenceInput, daysBeforeCancel } from "./evidence-input"
import { DAY_MS, WINDOW_DAYS } from "./snapshot"

export const SERVICES_SHOWN = 15
/** Values shown per resource attribute. */
export const RESOURCE_VALUES_SHOWN = 5
/** Rows read for resource attributes: every value of the five keys, in practice. */
const RESOURCE_ROWS_READ = 500
export const ALERT_ERROR_CLASSES_SHOWN = 10
export const ERROR_WEEKS = 8
export const PRODUCT_EVENTS_SHOWN = 25
/** Name and source pairs read; a name recorded as both server and trace is two rows. */
const PRODUCT_EVENT_ROWS_READ = PRODUCT_EVENTS_SHOWN * 2
export const AUDIT_ACTIONS_SHOWN = 25
export const TOOL_CALLS_SHOWN = 15
/** Service names, attribute values, event and tool names are cut to this. */
const NAME_CHARS = 80
const BYTES_PER_GB = 1_000_000_000
/** Well under the review's whole-section timeout. */
const PART_TIMEOUT = "8 seconds"

const cut = (name: string): string => name.slice(0, NAME_CHARS)

/** Three significant figures: a 2 MB service stays visible, a 40 GB one loses nothing that matters. */
const gb = (bytes: number): number => Number((bytes / BYTES_PER_GB).toPrecision(3))

const share = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 1000

export interface ServiceUsageRow {
	readonly serviceName: string
	readonly recentTraceBytes: number
	readonly recentLogBytes: number
	readonly recentMetricBytes: number
	readonly priorTraceBytes: number
	readonly priorLogBytes: number
	readonly priorMetricBytes: number
	readonly firstHour: DateTime.Utc
	readonly lastHour: DateTime.Utc
	readonly activeDaysRecent: number
	readonly activeDaysPrior: number
}

export const servicesOf = (
	rows: ReadonlyArray<ServiceUsageRow>,
	counts: { readonly distinctRecent: number; readonly distinctPrior: number },
	atMs: number,
): CancellationServices => {
	const volume = (traces: number, logs: number, metrics: number): CancellationSignalVolume => ({
		tracesGB: gb(traces),
		logsGB: gb(logs),
		metricsGB: gb(metrics),
	})
	return {
		distinctRecent: counts.distinctRecent,
		distinctPrior: counts.distinctPrior,
		top: rows.slice(0, SERVICES_SHOWN).map((row) => ({
			name: cut(row.serviceName),
			recent: volume(row.recentTraceBytes, row.recentLogBytes, row.recentMetricBytes),
			prior: volume(row.priorTraceBytes, row.priorLogBytes, row.priorMetricBytes),
			firstSeenDaysBeforeCancel: daysBeforeCancel(atMs, DateTime.toEpochMillis(row.firstHour)),
			lastSeenDaysBeforeCancel: daysBeforeCancel(atMs, DateTime.toEpochMillis(row.lastHour)),
			activeDaysRecent: row.activeDaysRecent,
			activeDaysPrior: row.activeDaysPrior,
		})),
	}
}

export interface ResourceAttributeRow {
	readonly attributeKey: string
	readonly attributeValue: string
	readonly spans: number
}

/** The attribute keys behind each key shown; `environment` has two spellings. */
const RESOURCE_SOURCES: ReadonlyArray<readonly [CancellationResourceKey, ReadonlyArray<string>]> = [
	["environment", ["deployment.environment.name", "deployment.environment"]],
	["telemetry.sdk.language", ["telemetry.sdk.language"]],
	["telemetry.sdk.name", ["telemetry.sdk.name"]],
	["telemetry.sdk.version", ["telemetry.sdk.version"]],
]

/**
 * Each key's most common values as shares of the window's `spans`, and the
 * share that did not set it. A value under both environment spellings counts
 * its larger count: a service setting both is counted once, at the price of
 * undercounting a fleet that splits one value across the two. Empty when no
 * spans arrived: there is nothing to share.
 */
export const resourceAttributesOf = (
	rows: ReadonlyArray<ResourceAttributeRow>,
	spans: number,
): ReadonlyArray<CancellationResourceAttribute> => {
	if (spans === 0) return []
	return RESOURCE_SOURCES.map(([key, sources]) => {
		const byValue = new Map<string, number>()
		for (const row of rows.filter((row) => sources.includes(row.attributeKey))) {
			byValue.set(row.attributeValue, Math.max(byValue.get(row.attributeValue) ?? 0, row.spans))
		}
		const values = [...byValue].toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
		const set = values.reduce((sum, [, count]) => sum + count, 0)
		// The rollup counts the keys apart; never let one exceed the whole.
		const whole = Math.max(spans, set)
		return {
			key,
			notSetShare: share(whole - set, whole),
			values: values
				.slice(0, RESOURCE_VALUES_SHOWN)
				.map(([value, count]) => ({ value: cut(value), share: share(count, whole) })),
		}
	})
}

export interface AlertCheckRow {
	readonly status: string
	readonly skipReason: string
	readonly errorCategory: string
	readonly checks: number
	readonly ruleIds: ReadonlyArray<string>
}

export const alertChecksOf = (rows: ReadonlyArray<AlertCheckRow>): CancellationAlertChecks => {
	const sum = (match: (row: AlertCheckRow) => boolean) =>
		rows.filter(match).reduce((total, row) => total + row.checks, 0)
	const skipped = (reason: string) => sum((row) => row.status === "skipped" && row.skipReason === reason)
	const errors = new Map<string, number>()
	for (const row of rows.filter((row) => row.status === "error")) {
		const category = row.errorCategory === "" ? "unknown" : row.errorCategory
		errors.set(category, (errors.get(category) ?? 0) + row.checks)
	}
	const rulesOf = (match: (row: AlertCheckRow) => boolean) =>
		new Set(rows.filter(match).flatMap((row) => row.ruleIds)).size
	return {
		checks: sum(() => true),
		healthy: sum((row) => row.status === "healthy"),
		breached: sum((row) => row.status === "breached"),
		skipped: {
			noData: skipped("no_data"),
			belowMinSamples: skipped("below_min_samples"),
			noValue: skipped("no_value"),
			unspecified: skipped(""),
		},
		errors: [...errors]
			.map(([category, checks]) => ({ category, checks }))
			.toSorted((a, b) => b.checks - a.checks)
			.slice(0, ALERT_ERROR_CLASSES_SHOWN),
		rules: rulesOf(() => true),
		rulesBreached: rulesOf((row) => row.status === "breached"),
	}
}

/** `days` are UTC day buckets; the oldest, partly before the window, is counted in the last week. */
export const errorVolumeOf = (
	days: ReadonlyArray<{ readonly day: DateTime.Utc; readonly errors: number }>,
	fingerprints: { readonly fingerprintsRecent: number; readonly fingerprintsPrior: number },
	atMs: number,
): CancellationErrorVolume => {
	const weekOf = (day: DateTime.Utc) =>
		Math.min(
			Math.max(Math.floor(daysBeforeCancel(atMs, DateTime.toEpochMillis(day)) / 7), 0),
			ERROR_WEEKS - 1,
		)
	const perWeek = Array.from({ length: ERROR_WEEKS }, (_, week) =>
		days.filter((row) => weekOf(row.day) === week).reduce((sum, row) => sum + row.errors, 0),
	)
	return { perWeek, ...fingerprints }
}

export interface ProductEventRow {
	readonly eventName: string
	readonly recent: number
	readonly prior: number
	readonly lastAt: DateTime.Utc
}

/**
 * One entry per event name. An annotated span is recorded both as a server
 * event and as its trace's copy: the larger count stands, never the sum. Plan
 * events (`plan_*`) are left out: the billing section already says what the
 * plan did, and these count every checkout and switch.
 */
export const productEventsOf = (
	rows: ReadonlyArray<ProductEventRow>,
	atMs: number,
): ReadonlyArray<CancellationProductEvent> => {
	const byName = new Map<string, { recent: number; prior: number; lastMs: number }>()
	for (const row of rows) {
		if (row.eventName.startsWith("plan_")) continue
		const lastMs = DateTime.toEpochMillis(row.lastAt)
		const seen = byName.get(row.eventName)
		byName.set(row.eventName, {
			recent: Math.max(seen?.recent ?? 0, row.recent),
			prior: Math.max(seen?.prior ?? 0, row.prior),
			lastMs: Math.max(seen?.lastMs ?? lastMs, lastMs),
		})
	}
	return [...byName]
		.toSorted(([a, x], [b, y]) => y.recent + y.prior - (x.recent + x.prior) || a.localeCompare(b))
		.slice(0, PRODUCT_EVENTS_SHOWN)
		.map(([name, event]) => ({
			name: cut(name),
			recent: event.recent,
			prior: event.prior,
			lastDaysBeforeCancel: daysBeforeCancel(atMs, event.lastMs),
		}))
}

/** `rows` are per audit actor type; a type with no entries has no row. */
export const auditActorsOf = (
	rows: ReadonlyArray<{ readonly actorType: string; readonly recent: number; readonly prior: number }>,
): CancellationAuditActors => {
	const of = (actorType: string) => {
		const row = rows.find((row) => row.actorType === actorType)
		return { recent: row?.recent ?? 0, prior: row?.prior ?? 0 }
	}
	return { users: of("user"), apiKeys: of("api_key"), agents: of("agent"), maple: of("system") }
}

/** A part that fails or runs long is `null`, never the end of the section. */
const part = <A, E>(span: string, read: Effect.Effect<A, E>): Effect.Effect<A | null> =>
	read.pipe(
		Effect.timeout(PART_TIMEOUT),
		Effect.map((value): A | null => value),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.logWarning("cancellation telemetry evidence could not read a part").pipe(
						Effect.annotateLogs({ part: span, error: summarizeCause(cause) }),
						Effect.as(null),
					),
		),
		Effect.withSpan(span),
	)

export class CancellationTelemetryEvidenceReader extends Context.Service<
	CancellationTelemetryEvidenceReader,
	{ readonly read: (input: CancellationEvidenceInput) => Effect.Effect<TelemetryEvidence> }
>()("@maple/backend/cancellation-review/CancellationTelemetryEvidenceReader", {
	make: Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService

		const read = Effect.fn("CancellationTelemetryEvidenceReader.read")(function* (
			input: CancellationEvidenceInput,
		) {
			const { orgId, ownOrgId, atMs } = input
			const tenant = systemTenant(orgId)
			const window = {
				orgId,
				startTime: formatWarehouseDateTime(atMs - WINDOW_DAYS * 2 * DAY_MS),
				splitTime: formatWarehouseDateTime(atMs - WINDOW_DAYS * DAY_MS),
				endTime: formatWarehouseDateTime(atMs),
			}
			const recentOnly = { orgId, startTime: window.splitTime, endTime: window.endTime }
			const weeks = {
				orgId,
				startTime: formatWarehouseDateTime(atMs - ERROR_WEEKS * 7 * DAY_MS),
				endTime: window.endTime,
			}
			const options = (context: string) => ({ profile: "list" as const, context })

			return yield* Effect.all(
				{
					services: part(
						"CancellationTelemetryEvidenceReader.readServices",
						Effect.all([
							warehouse.compiledQuery(
								tenant,
								CH.compile(
									CH.cancellationServiceUsageQuery({ limit: SERVICES_SHOWN }),
									window,
								),
								options("cancellationEvidenceServices"),
							),
							warehouse.compiledQuery(
								tenant,
								CH.compile(CH.cancellationServiceCountsQuery(), window),
								options("cancellationEvidenceServiceCounts"),
							),
						]).pipe(
							Effect.map(([rows, [counts]]) =>
								servicesOf(rows, counts ?? { distinctRecent: 0, distinctPrior: 0 }, atMs),
							),
						),
					),
					resourceAttributes: part(
						"CancellationTelemetryEvidenceReader.readResourceAttributes",
						Effect.all([
							warehouse.compiledQuery(
								tenant,
								CH.compile(
									CH.cancellationResourceAttributesQuery({ limit: RESOURCE_ROWS_READ }),
									window,
								),
								options("cancellationEvidenceResourceAttributes"),
							),
							warehouse.compiledQuery(
								tenant,
								CH.compile(CH.cancellationResourceSpansQuery(), window),
								options("cancellationEvidenceResourceSpans"),
							),
						]).pipe(
							Effect.map(([rows, [total]]) => resourceAttributesOf(rows, total?.spans ?? 0)),
						),
					),
					alertChecks: part(
						"CancellationTelemetryEvidenceReader.readAlertChecks",
						warehouse
							.compiledQuery(
								tenant,
								CH.compile(CH.cancellationAlertChecksQuery(), recentOnly),
								options("cancellationEvidenceAlertChecks"),
							)
							.pipe(Effect.map(alertChecksOf)),
					),
					errors: part(
						"CancellationTelemetryEvidenceReader.readErrors",
						Effect.all([
							warehouse.compiledQuery(
								tenant,
								CH.compile(CH.cancellationErrorsByDayQuery(), weeks),
								options("cancellationEvidenceErrorsByDay"),
							),
							warehouse.compiledQuery(
								tenant,
								CH.compile(CH.cancellationErrorFingerprintsQuery(), window),
								options("cancellationEvidenceErrorFingerprints"),
							),
						]).pipe(
							Effect.map(([days, [fingerprints]]) =>
								errorVolumeOf(
									days,
									{
										fingerprintsRecent: fingerprints?.distinctRecent ?? 0,
										fingerprintsPrior: fingerprints?.distinctPrior ?? 0,
									},
									atMs,
								),
							),
						),
					),
					// The org's events live under Maple's own org, tagged with the org as `GroupId`.
					productEvents:
						ownOrgId === null
							? Effect.succeed(null)
							: part(
									"CancellationTelemetryEvidenceReader.readProductEvents",
									warehouse
										.compiledQuery(
											systemTenant(ownOrgId),
											CH.compile(
												CH.cancellationProductEventsQuery({
													limit: PRODUCT_EVENT_ROWS_READ,
												}),
												{ ...window, orgId: ownOrgId, groupId: orgId },
											),
											options("cancellationEvidenceProductEvents"),
										)
										.pipe(Effect.map((rows) => productEventsOf(rows, atMs))),
								),
					auditActors: part(
						"CancellationTelemetryEvidenceReader.readAuditActors",
						warehouse
							.compiledQuery(
								tenant,
								CH.compile(CH.cancellationAuditActorsQuery(), window),
								options("cancellationEvidenceAuditActors"),
							)
							.pipe(Effect.map(auditActorsOf)),
					),
					auditActions: part(
						"CancellationTelemetryEvidenceReader.readAuditActions",
						warehouse
							.compiledQuery(
								tenant,
								CH.compile(
									CH.cancellationAuditActionsQuery({ limit: AUDIT_ACTIONS_SHOWN }),
									window,
								),
								options("cancellationEvidenceAuditActions"),
							)
							.pipe(
								Effect.map((rows) =>
									rows.map(({ action, recent, prior, denied }) => ({
										action,
										recent,
										prior,
										denied,
									})),
								),
							),
					),
					toolCalls: part(
						"CancellationTelemetryEvidenceReader.readToolCalls",
						warehouse
							.compiledQuery(
								tenant,
								CH.compile(
									CH.cancellationToolCallsQuery({ limit: TOOL_CALLS_SHOWN }),
									window,
								),
								options("cancellationEvidenceToolCalls"),
							)
							.pipe(
								Effect.map((rows) =>
									rows.map(({ tool, surface, recent, prior, errors }) => ({
										tool: cut(tool),
										surface,
										recent,
										prior,
										errors,
									})),
								),
							),
					),
				},
				// A Worker keeps six connections open at once; the rest of the review needs some.
				// A part's two queries run one after the other, so this caps the section's.
				{ concurrency: 3 },
			)
		})

		return { read }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
