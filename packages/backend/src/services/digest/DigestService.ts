import * as PG from "@maple-dev/effect-orm/postgres"
import { DigestSubscriptions, type DigestSubscriptionRow } from "@maple/db/tables"
import {
	DigestNotConfiguredError,
	DigestNotFoundError,
	DigestPersistenceError,
	DigestPreviewResponse,
	DigestRenderError,
	DigestSubscriptionId,
	DigestSubscriptionResponse,
	DigestUnsubscribeTokenInvalidError,
	EmailUnsubscribeResponse,
	OrgId,
	UserId,
	RoleName,
} from "@maple/domain/http"
import type { RoleName as RoleNameType } from "@maple/domain/http"
import { createClerkClient } from "@clerk/backend"
import {
	Clock,
	Array as Arr,
	Cause,
	DateTime,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
	Context,
} from "effect"
import {
	computeDelta,
	deriveDigestStatus,
	type DigestBreakdownRow,
	type DigestEnvironmentGroup,
	type DigestScope,
	type DigestService as DigestServiceRow,
	type WeeklyDigestProps,
} from "@maple/email/weekly-digest-core"
import { renderWeeklyDigest } from "@maple/email/weekly-digest"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env } from "@maple/backend/platform/Env"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { EdgeCacheService } from "@maple/cache"
import { clerkRequest } from "@maple/backend/services/auth/clerk-request"
import {
	isOrgWarehouseQuarantined,
	quarantineOnConfigClassCause,
} from "@maple/backend/services/warehouse/warehouse-org-quarantine"

import { formatWarehouseDateTime } from "@maple/query-engine"
import * as CH from "@maple/query-engine/ch"
import { resolveOrgName } from "./resolve-org-name"
import { unsubscribeLinks, verifyUnsubscribeToken } from "./unsubscribe-token"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
const SYSTEM_DIGEST_USER = UserId.make("system-digest")
const ROOT_ROLE = RoleName.make("root")

const toPersistenceError = (error: unknown) =>
	new DigestPersistenceError({
		message: error instanceof Error ? error.message : `Digest persistence error: ${String(error)}`,
	})

/** Row shapes matching query engine output (camelCase from CH DSL) */
interface ServiceOverviewRow {
	serviceName: string
	/** `serviceOverviewQuery` groups by (serviceName, environment) — both are part
	 * of the row identity, and dropping either collapses distinct rows together. */
	environment: string
	serviceNamespace: string
	throughput: number
	estimatedSpanCount: number
	errorCount: number
	estimatedErrorCount: number
	p95LatencyMs: number
}

/** `tracesBreakdownQuery` grouped by `"all"`: one row for the whole window. */
interface TracesBreakdownRow {
	name: string
	count: number
	errorRate: number
	p95Duration: number
}

interface ServiceUsageRow {
	serviceName: string
	totalLogCount: number
	totalLogSizeBytes: number
	totalTraceCount: number
	totalTraceSizeBytes: number
	totalSumMetricCount: number
	totalSumMetricSizeBytes: number
	totalGaugeMetricCount: number
	totalGaugeMetricSizeBytes: number
	totalHistogramMetricCount: number
	totalHistogramMetricSizeBytes: number
	totalExpHistogramMetricCount: number
	totalExpHistogramMetricSizeBytes: number
	totalSizeBytes: number
}

/** Empty arrays mean "the whole org", which is every pre-existing subscription. */
const UNSCOPED: DigestScope = { environments: [], namespaces: [] }

/**
 * Stable identity of a digest render: two subscribers with the same scope share
 * one set of warehouse queries and one rendered email.
 */
const scopeKey = (orgId: string, scope: DigestScope): string =>
	JSON.stringify([orgId, [...scope.environments].sort(), [...scope.namespaces].sort()])

const StoredScopeColumn = Schema.fromJsonString(Schema.Array(Schema.String))
const decodeScopeColumn = Schema.decodeUnknownOption(StoredScopeColumn)

/**
 * `[]` for anything that is not a JSON array of strings — a malformed scope
 * column must widen the digest, never fail the send. Decoded rather than
 * `JSON.parse`d because this runs inside `Arr.groupBy` while partitioning
 * subscriptions: a throw there would abort the whole tick, taking every valid
 * subscriber down with the one bad row.
 */
const parseScopeColumn = (raw: string | null): ReadonlyArray<string> =>
	raw == null || raw === "" ? [] : Option.getOrElse(decodeScopeColumn(raw), () => [])

const nonEmpty = (values: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
	const kept = values.filter((value) => value !== "")
	return kept.length > 0 ? kept : undefined
}

/**
 * The grain `serviceOverviewQuery` actually returns: it groups by
 * `(serviceName, environment)`. Keying the previous-window lookup on the
 * service name alone made every environment of a service compare against
 * whichever row happened to be last, which is where the wildly wrong
 * per-service percentages came from.
 *
 * Namespace is deliberately NOT part of this key. The query emits it as
 * `argMax(cServiceNamespace, cEstimatedSpanCount)` — the *dominant* namespace,
 * display metadata rather than row identity — so a service whose busiest
 * namespace shifts between the two weeks would fail to match its own previous
 * row and be reported as new.
 */
const serviceKey = (row: { serviceName: string; environment: string }): string =>
	`${row.serviceName}\u0000${row.environment}`

/** Rows in the service-health table, applied at the (service, environment)
 * grain the table actually renders. */
const DIGEST_SERVICE_LIMIT = 10

/** Rows in each breakdown table. */
const DIGEST_BREAKDOWN_LIMIT = 10

/** Sum `estimatedSpanCount` per environment across a whole window's rows. */
function requestsByEnvironment(rows: ReadonlyArray<ServiceOverviewRow>): Map<string, number> {
	const totals = new Map<string, number>()
	for (const row of rows) {
		const environment = row.environment
		totals.set(environment, (totals.get(environment) ?? 0) + (row.estimatedSpanCount || 0))
	}
	return totals
}

/**
 * Split the rendered services into one block per environment, ordered by
 * request volume, each block carrying its own total and week-over-week
 * comparison.
 *
 * The header totals come from the FULL current and previous windows, not from
 * the rendered rows. `services` is capped at {@link DIGEST_SERVICE_LIMIT}, so
 * summing it while comparing against every previous row measured two different
 * populations: an org with more than ten services saw a stable environment
 * report an invented decline. Both sides now cover the whole environment, which
 * also makes the header the environment's real traffic rather than "the part of
 * it that fit in the table".
 */
function groupServicesByEnvironment(
	services: ReadonlyArray<DigestServiceRow>,
	current: ReadonlyArray<ServiceOverviewRow>,
	previous: ReadonlyArray<ServiceOverviewRow>,
): Array<DigestEnvironmentGroup> {
	const currentTotals = requestsByEnvironment(current)
	const previousTotals = requestsByEnvironment(previous)

	const byEnvironment = new Map<string, Array<DigestServiceRow>>()
	for (const service of services) {
		const bucket = byEnvironment.get(service.environment)
		if (bucket) bucket.push(service)
		else byEnvironment.set(service.environment, [service])
	}

	return [...byEnvironment.entries()]
		.map(([environment, groupServices]) => {
			const requests = currentTotals.get(environment) ?? 0
			return {
				environment,
				requests,
				requestsDelta: computeDelta(requests, previousTotals.get(environment) ?? 0),
				services: groupServices,
			}
		})
		.sort((a, b) => b.requests - a.requests)
}

/**
 * Per-environment totals, aggregated from the overview rows the digest already
 * holds — no extra query, and exact, because `serviceOverviewQuery` groups by
 * `(serviceName, environment)`, so environment is a real grouping key.
 *
 * This does NOT work for namespace: the query collapses namespace variants and
 * reports only `argMax(cServiceNamespace, …)`, so summing these rows by
 * namespace would file all of a service's traffic under whichever namespace was
 * busiest. {@link buildBreakdownFromRows} handles namespace from a genuinely
 * namespace-grouped query instead.
 *
 * P95 is deliberately absent from both: per-service quantiles cannot be merged
 * client-side, and averaging them is exactly the bug this pass removes.
 */
function buildBreakdown(
	current: ReadonlyArray<ServiceOverviewRow>,
	previous: ReadonlyArray<ServiceOverviewRow>,
	dimension: (row: ServiceOverviewRow) => string,
): Array<DigestBreakdownRow> {
	const totals = new Map<string, { requests: number; errors: number }>()
	for (const row of current) {
		const label = dimension(row)
		const entry = totals.get(label) ?? { requests: 0, errors: 0 }
		entry.requests += row.estimatedSpanCount || 0
		entry.errors += row.estimatedErrorCount || 0
		totals.set(label, entry)
	}

	const prevTotals = new Map<string, number>()
	for (const row of previous) {
		const label = dimension(row)
		prevTotals.set(label, (prevTotals.get(label) ?? 0) + (row.estimatedSpanCount || 0))
	}

	return [...totals.entries()]
		.map(([label, { requests, errors }]) => ({
			label,
			requests,
			errorRate: requests > 0 ? (errors / requests) * 100 : 0,
			requestsDelta: computeDelta(requests, prevTotals.get(label) ?? 0),
		}))
		.sort((a, b) => b.requests - a.requests)
}

/**
 * Breakdown rows straight off a `tracesBreakdownQuery` grouped by a real
 * dimension. `count` is the sample-weighted request count and `errorRate` a
 * fraction, matching the summary cards.
 */
function buildBreakdownFromRows(
	current: ReadonlyArray<TracesBreakdownRow>,
	previous: ReadonlyArray<TracesBreakdownRow>,
): Array<DigestBreakdownRow> {
	const previousByName = new Map(previous.map((row) => [row.name, row.count || 0] as const))
	return current
		.map((row) => {
			const label = row.name
			const requests = row.count || 0
			return {
				label,
				requests,
				errorRate: (row.errorRate || 0) * 100,
				requestsDelta: computeDelta(requests, previousByName.get(label) ?? 0),
			}
		})
		.sort((a, b) => b.requests - a.requests)
}

export class DigestService extends Context.Service<DigestService>()("@maple/api/services/DigestService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const email = yield* EmailService
		const env = yield* Env
		const warehouse = yield* WarehouseQueryService
		const edgeCache = yield* EdgeCacheService
		const linkConfig = {
			secret: Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY),
			appBaseUrl: env.MAPLE_APP_BASE_URL,
			apiBaseUrl: env.MAPLE_API_BASE_URL,
		}

		const getSubscription = Effect.fn("DigestService.getSubscription")(function* (
			orgId: OrgId,
			userId: UserId,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("tenant.userId", userId)

			const rows = yield* database
				.execute((db) =>
					db.run(
						PG.from(DigestSubscriptions)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.userId.eq(userId)])
							.limit(1),
					),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = rows[0]
			if (!row) {
				return yield* new DigestNotFoundError({
					message: "No digest subscription found",
				})
			}

			return rowToResponse(row)
		})

		const upsertSubscription = Effect.fn("DigestService.upsertSubscription")(function* (
			orgId: OrgId,
			userId: UserId,
			input: {
				email: string
				enabled?: boolean
				dayOfWeek?: number
				timezone?: string
				namespaces?: ReadonlyArray<string>
				environments?: ReadonlyArray<string>
				webAnalyticsEnabled?: boolean
			},
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("tenant.userId", userId)

			const now = yield* Clock.currentTimeMillis
			const id = crypto.randomUUID()

			yield* database
				.execute((db) =>
					db.run(
						PG.insertInto(DigestSubscriptions)
							.values({
								id,
								orgId,
								userId,
								email: input.email,
								enabled: input.enabled !== false,
								optedOutAt: input.enabled === false ? now : null,
								dayOfWeek: input.dayOfWeek ?? 1,
								timezone: input.timezone ?? "UTC",
								namespacesJson: JSON.stringify(input.namespaces ?? []),
								environmentsJson: JSON.stringify(input.environments ?? []),
								webAnalyticsEnabled: input.webAnalyticsEnabled !== false,
								webAnalyticsOptedOutAt: input.webAnalyticsEnabled === false ? now : null,
								createdAt: now,
								updatedAt: now,
							})
							.onConflictDoUpdate({
								target: ["orgId", "userId"],
								set: {
									email: input.email,
									enabled: input.enabled !== false,
									// The subscriber turning the digest off is the one signal the
									// Clerk reconciliation must not overwrite; stamp it here so it
									// can tell an opt-out from a member it disabled itself.
									optedOutAt: input.enabled === false ? now : null,
									...(input.dayOfWeek != null ? { dayOfWeek: input.dayOfWeek } : undefined),
									...(input.timezone != null ? { timezone: input.timezone } : undefined),
									...(input.namespaces != null
										? { namespacesJson: JSON.stringify(input.namespaces) }
										: undefined),
									...(input.environments != null
										? { environmentsJson: JSON.stringify(input.environments) }
										: undefined),
									// Only touched when sent, so saving the ops digest never flips it.
									...(input.webAnalyticsEnabled != null
										? {
												webAnalyticsEnabled: input.webAnalyticsEnabled,
												webAnalyticsOptedOutAt: input.webAnalyticsEnabled
													? null
													: now,
											}
										: undefined),
									updatedAt: now,
								},
							}),
					),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return yield* getSubscription(orgId, userId)
		})

		/**
		 * The digest is opt-out: every current member is a subscriber, so the
		 * Clerk reconciliation recreates any row it does not find. Deleting the
		 * row would therefore last until the next tick — the opt-out has to be
		 * recorded, not erased.
		 */
		const deleteSubscription = Effect.fn("DigestService.deleteSubscription")(function* (
			orgId: OrgId,
			userId: UserId,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("tenant.userId", userId)

			const now = yield* Clock.currentTimeMillis

			yield* database
				.execute((db) =>
					db.run(
						PG.update(DigestSubscriptions)
							.set({ enabled: false, optedOutAt: now, updatedAt: now })
							.where(($) => [$.orgId.eq(orgId), $.userId.eq(userId)]),
					),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		/**
		 * The login-free unsubscribe behind every digest email's link and one-click header.
		 * Records the opt-out the same way the settings toggle does, so the Clerk sweep keeps it.
		 */
		const unsubscribeByToken = Effect.fn("DigestService.unsubscribeByToken")(function* (token: string) {
			const verified = verifyUnsubscribeToken(
				Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY),
				token,
			)
			if (verified === undefined) {
				return yield* new DigestUnsubscribeTokenInvalidError({
					message: "This unsubscribe link is invalid",
				})
			}
			yield* Effect.annotateCurrentSpan("maple.email.unsubscribe_kind", verified.kind)

			const now = yield* Clock.currentTimeMillis
			// Idempotent: a repeat click (or a deleted row) changes nothing and still succeeds.
			yield* database
				.execute((db) =>
					db.run(
						PG.update(DigestSubscriptions)
							.set(
								verified.kind === "digest"
									? { enabled: false, optedOutAt: now, updatedAt: now }
									: {
											webAnalyticsEnabled: false,
											webAnalyticsOptedOutAt: now,
											updatedAt: now,
										},
							)
							.where(($) => [$.id.eq(verified.subscriptionId)]),
					),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return new EmailUnsubscribeResponse({ kind: verified.kind })
		})

		const generateDigestData = Effect.fn("DigestService.generateDigestData")(function* (
			orgId: OrgId,
			scope: DigestScope = UNSCOPED,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("digest.environments", scope.environments.join(","))
			yield* Effect.annotateCurrentSpan("digest.namespaces", scope.namespaces.join(","))

			const now = new Date(yield* Clock.currentTimeMillis)

			// Every window is day-aligned to UTC midnight. `bucket_seconds: 86_400`
			// snaps `toStartOfInterval` to UTC midnight, so a rolling now-7d window
			// would split into 8 partial-day buckets (a duplicated weekday at the
			// seam). Aligning the *summary* windows to the same boundaries is what
			// makes the sparkline's bars add up to the headline Requests number —
			// they used to be measured over different spans.
			const DAY_MS = 24 * 60 * 60 * 1000
			const todayStartMs = Math.floor(now.getTime() / DAY_MS) * DAY_MS
			const currentStartMs = todayStartMs - 7 * DAY_MS
			const previousStartMs = todayStartMs - 14 * DAY_MS

			const currentStart = formatWarehouseDateTime(currentStartMs)
			const currentEnd = formatWarehouseDateTime(todayStartMs - 1000)
			const previousStart = formatWarehouseDateTime(previousStartMs)
			const previousEnd = formatWarehouseDateTime(currentStartMs - 1000)

			const systemTenant = {
				orgId,
				userId: SYSTEM_DIGEST_USER,
				roles: [ROOT_ROLE] as ReadonlyArray<RoleNameType>,
				authMode: "self_hosted" as const,
			}

			// Filter lists are omitted rather than sent empty: an empty list would be
			// a filter that matches nothing, not the absence of a filter.
			const environments = nonEmpty(scope.environments)
			const namespaces = nonEmpty(scope.namespaces)
			const window = (startTime: string, endTime: string) => ({ orgId, startTime, endTime })
			// A weekly background job over two 7-day windows: the aggregation budget.
			const run = <T>(compiled: CH.CompiledQueryInput<T>, context: string) =>
				warehouse.compiledQuery(systemTenant, compiled, { profile: "aggregation", context })

			// Warm the route once before the fan-out, so the org-config read isn't
			// racing concurrent warehouse fetches for a connection slot.
			yield* warehouse.warmRoute(systemTenant)

			const warehouseFailure = (error: unknown) =>
				new DigestPersistenceError({
					message: `Failed to fetch digest data from the warehouse: ${error instanceof Error ? error.message : String(error)}`,
				})

			// The overview and usage compares UNION ALL current + previous into one
			// query, tagging rows with `period`. The two summary breakdowns collapse
			// to a single row each (`groupBy: "all"`) so the P95 is a real merged
			// quantile rather than a throughput-weighted mean of per-service P95s.
			const tracesBreakdown = (
				groupBy: "all" | "namespace",
				limit: number,
				startTime: string,
				endTime: string,
				context: string,
			) =>
				run(
					CH.compile(
						CH.tracesBreakdownQuery({
							metric: "count",
							allMetrics: true,
							groupBy,
							limit,
							rootOnly: true,
							environments,
							namespaces,
						}),
						window(startTime, endTime),
					),
					context,
				)

			const [overviewRows, curSummary, prevSummary, seriesRows, curNamespaces, prevNamespaces] =
				yield* Effect.all(
					[
						run(
							CH.compilePeriodCompare(
								CH.serviceOverviewQuery({ environments, namespaces }),
								{ orgId, currentStart, currentEnd, previousStart, previousEnd },
								CH.serviceOverviewRowSchema,
							),
							"digestServiceOverviewCompare",
						),
						tracesBreakdown("all", 1, currentStart, currentEnd, "digestTracesSummary"),
						tracesBreakdown("all", 1, previousStart, previousEnd, "digestTracesSummary"),
						run(
							CH.compile(
								CH.tracesTimeseriesQuery({
									metric: "count",
									allMetrics: true,
									needsSampling: true,
									groupBy: [],
									rootOnly: true,
									environments,
									namespaces,
								}),
								{ ...window(currentStart, currentEnd), bucketSeconds: 86_400 },
							),
							"digestDailySeries",
						),
						tracesBreakdown(
							"namespace",
							DIGEST_BREAKDOWN_LIMIT,
							currentStart,
							currentEnd,
							"digestNamespaceBreakdown",
						),
						tracesBreakdown(
							"namespace",
							DIGEST_BREAKDOWN_LIMIT,
							previousStart,
							previousEnd,
							"digestNamespaceBreakdown",
						),
					],
					{ concurrency: 6 },
				).pipe(Effect.mapError(warehouseFailure))

			// Split UNION ALL'd rows by period discriminator
			const curOverviewData = overviewRows.filter((r) => r.period === "current")
			const prevOverviewData = overviewRows.filter((r) => r.period === "previous")

			// Neither `service_usage` nor `error_events` carries an environment or
			// namespace column, so a scoped digest narrows both by the service
			// membership the scope resolved to — the same approximation the web app
			// makes in `scopeServicesToNamespaces`. A service emitting under two
			// namespaces stays counted in both.
			const isScoped = scope.environments.length > 0 || scope.namespaces.length > 0
			const membership = nonEmpty([...new Set(curOverviewData.map((r) => r.serviceName))])

			// A scope that matched no services means "no data", not "no filter".
			// Falling through to an unfiltered query would have shown org-wide
			// ingestion and org-wide errors inside a digest that claims to cover one
			// namespace.
			const scopeIsEmpty = isScoped && membership === undefined
			const serviceFilter = isScoped ? membership : undefined

			const errorsByType = (
				startTime: string,
				endTime: string,
				limit: number,
				fingerprintHashes: ReadonlyArray<string> | undefined,
				context: string,
			) =>
				run(
					CH.compile(
						CH.errorsByTypeQuery({
							services: serviceFilter,
							// `error_events` has no `ServiceNamespace` column, so errors scope
							// by environment only (plus the service membership above).
							deploymentEnvs: environments,
							fingerprintHashes,
							limit,
						}),
						window(startTime, endTime),
					),
					context,
				)

			const [usageRows, topErrors] = yield* Effect.all(
				[
					scopeIsEmpty
						? Effect.succeed([])
						: run(
								CH.compilePeriodCompare(
									CH.serviceUsageQuery({ serviceNames: serviceFilter }),
									{ orgId, currentStart, currentEnd, previousStart, previousEnd },
									CH.serviceUsageRowSchema,
								),
								"digestServiceUsageCompare",
							),
					scopeIsEmpty
						? Effect.succeed([])
						: errorsByType(currentStart, currentEnd, 5, undefined, "digestTopErrors"),
				],
				{ concurrency: 2 },
			).pipe(Effect.mapError(warehouseFailure))

			const summaryRow = (rows: ReadonlyArray<TracesBreakdownRow>): TracesBreakdownRow => {
				const row = rows[0]
				return {
					name: "all",
					count: row?.count || 0,
					errorRate: row?.errorRate || 0,
					p95Duration: row?.p95Duration || 0,
				}
			}
			const cur = summaryRow(curSummary)
			const prev = summaryRow(prevSummary)

			// `errorRate` here is a fraction (0–1), weighted on both sides of the
			// ratio — not the 0–100 percentage the per-service rows carry.
			const totalRequests = cur.count
			const prevTotalRequests = prev.count
			const totalErrors = Math.round(cur.count * cur.errorRate)
			const prevTotalErrors = Math.round(prev.count * prev.errorRate)

			// Data volume — split UNION ALL'd rows by period discriminator
			const curUsageData = usageRows.filter((r) => r.period === "current")
			const prevUsageData = usageRows.filter((r) => r.period === "previous")
			const sumUsage = (data: ReadonlyArray<ServiceUsageRow>) => ({
				logs: data.reduce((s, r) => s + (r.totalLogCount || 0), 0),
				traces: data.reduce((s, r) => s + (r.totalTraceCount || 0), 0),
				metrics: data.reduce(
					(s, r) =>
						s +
						(r.totalSumMetricCount || 0) +
						(r.totalGaugeMetricCount || 0) +
						(r.totalHistogramMetricCount || 0) +
						(r.totalExpHistogramMetricCount || 0),
					0,
				),
				totalBytes: data.reduce(
					(s, r) =>
						s +
						(r.totalLogSizeBytes || 0) +
						(r.totalTraceSizeBytes || 0) +
						(r.totalSumMetricSizeBytes || 0) +
						(r.totalGaugeMetricSizeBytes || 0) +
						(r.totalHistogramMetricSizeBytes || 0) +
						(r.totalExpHistogramMetricSizeBytes || 0),
					0,
				),
			})
			const curUsage = sumUsage(curUsageData)
			const prevUsage = sumUsage(prevUsageData)

			const formatDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" })

			// Per-service WoW deltas, matched on the grain the query actually
			// returns rather than on the service name alone.
			const prevRequestsByService = new Map<string, number>()
			for (const s of prevOverviewData) {
				prevRequestsByService.set(serviceKey(s), s.estimatedSpanCount || 0)
			}

			const services: Array<DigestServiceRow> = curOverviewData
				.map((s) => {
					// `estimatedSpanCount` is the sample-weighted count, matching the
					// summary cards and the rest of the product; `throughput` is the raw
					// stored-row count and disagrees with both under any sampling.
					const requests = s.estimatedSpanCount || 0
					const errors = s.estimatedErrorCount || 0
					return {
						name: s.serviceName,
						environment: s.environment,
						namespace: s.serviceNamespace,
						requests,
						errorRate: requests > 0 ? (errors / requests) * 100 : 0,
						p95Ms: s.p95LatencyMs || 0,
						requestsDelta: computeDelta(requests, prevRequestsByService.get(serviceKey(s)) ?? 0),
					}
				})
				.sort((a, b) => b.requests - a.requests)
				.slice(0, DIGEST_SERVICE_LIMIT)
				// Float the unhealthiest services to the top so problems surface
				// first. Array.sort is stable, so ties keep their request order.
				.sort((a, b) => b.errorRate - a.errorRate)

			const environmentGroups = groupServicesByEnvironment(services, curOverviewData, prevOverviewData)
			const breakdown = {
				environments: buildBreakdown(curOverviewData, prevOverviewData, (r) => r.environment),
				namespaces: buildBreakdownFromRows(curNamespaces, prevNamespaces),
			}

			// `errorsByTypeQuery` returns `min(Timestamp)` *within the window*, which is
			// always inside it — so newness has to be asked of the previous window
			// directly. Filtering to the five fingerprints we actually render makes
			// that exact, unlike diffing against the previous week's top 100.
			const currentErrors = topErrors.slice(0, 5)
			const currentFingerprints = currentErrors
				.map((e) => e.fingerprintHash)
				.filter((hash) => hash !== "")
			const prevErrorFingerprints = yield* currentFingerprints.length === 0
				? Effect.succeed(new Set<string>())
				: errorsByType(
						previousStart,
						previousEnd,
						currentFingerprints.length,
						currentFingerprints,
						"digestPreviousErrors",
					).pipe(
						Effect.map((rows) => new Set(rows.map((e) => e.fingerprintHash))),
						// A failed lookup must not invent NEW badges: falling back to an
						// empty set would mark every current error as first-seen during a
						// warehouse blip. Assume all of them existed last week instead —
						// the badge is lost, nothing is misreported.
						Effect.orElseSucceed(() => new Set(currentFingerprints)),
					)

			const errorsData = currentErrors.map((e) => ({
				message: e.errorLabel || e.sampleMessage || "Unknown error",
				count: e.count || 0,
				affectedServices: e.affectedServicesCount || 0,
				isNew: e.fingerprintHash ? !prevErrorFingerprints.has(e.fingerprintHash) : false,
			}))

			// Daily request/error buckets (one row per UTC day) for the sparkline.
			const weekdayInitial = (bucket: DateTime.Utc) =>
				["S", "M", "T", "W", "T", "F", "S"][DateTime.getPartUtc(bucket, "weekDay")] ?? ""
			const series = seriesRows
				.slice()
				.sort((a, b) => DateTime.toEpochMillis(a.bucket) - DateTime.toEpochMillis(b.bucket))
				// Guard against any boundary off-by-one — keep the 7 most recent days.
				.slice(-7)
				.map((r) => {
					const requests = r.count || 0
					return {
						label: weekdayInitial(r.bucket),
						requests,
						errors: Math.round(requests * (r.errorRate || 0)),
					}
				})

			const orgName = yield* resolveOrgName(env, orgId)

			const props: WeeklyDigestProps = {
				orgName,
				dateRange: {
					start: formatDate(new Date(currentStartMs)),
					end: formatDate(new Date(todayStartMs - DAY_MS)),
				},
				scope,
				summary: {
					requests: {
						value: totalRequests,
						delta: computeDelta(totalRequests, prevTotalRequests),
					},
					errors: {
						value: totalErrors,
						delta: computeDelta(totalErrors, prevTotalErrors),
					},
					p95Latency: {
						valueMs: cur.p95Duration,
						delta: computeDelta(cur.p95Duration, prev.p95Duration, "ms"),
					},
					dataVolume: {
						valueBytes: curUsage.totalBytes,
						delta: computeDelta(curUsage.totalBytes, prevUsage.totalBytes, "bytes"),
					},
				},
				series,
				services,
				environmentGroups,
				breakdown,
				topErrors: errorsData,
				ingestion: { ...curUsage, approximate: isScoped },
				baseUrl: env.MAPLE_APP_BASE_URL,
				dashboardUrl: env.MAPLE_APP_BASE_URL,
				unsubscribeUrl: `${env.MAPLE_APP_BASE_URL}/settings?tab=notifications`,
			}

			yield* Effect.annotateCurrentSpan("totalRequests", totalRequests)
			yield* Effect.annotateCurrentSpan("totalErrors", totalErrors)
			yield* Effect.annotateCurrentSpan("serviceCount", services.length)
			yield* Effect.logInfo("Digest data generated").pipe(
				Effect.annotateLogs({
					orgId,
					totalRequests,
					totalErrors,
					serviceCount: services.length,
					environments: scope.environments.join(","),
					namespaces: scope.namespaces.join(","),
				}),
			)

			return props
		})

		const renderDigestHtml = Effect.fn("DigestService.renderDigestHtml")(function* (
			props: WeeklyDigestProps,
		) {
			return yield* Effect.try({
				// Synchronous: the template is a compiled string, spliced in place.
				try: () => renderWeeklyDigest(props),
				catch: (error) =>
					new DigestRenderError({
						message: error instanceof Error ? error.message : "Failed to render digest email",
					}),
			})
		})

		const preview = Effect.fn("DigestService.preview")(function* (orgId: OrgId, userId?: UserId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)

			if (!email.isConfigured) {
				return yield* new DigestNotConfiguredError({
					message: "Email delivery is not configured",
				})
			}

			// Preview what this subscriber would actually receive, scope included.
			// A caller with no subscription yet previews the whole org.
			const scope = userId
				? yield* getSubscription(orgId, userId).pipe(
						Effect.map((sub): DigestScope => ({
							environments: sub.environments,
							namespaces: sub.namespaces,
						})),
						Effect.orElseSucceed(() => UNSCOPED),
					)
				: UNSCOPED

			const props = yield* generateDigestData(orgId, scope)
			const html = yield* renderDigestHtml(props)
			return new DigestPreviewResponse({ html })
		})

		// The digest tick fires every 15 minutes, so the daily Clerk sweep is
		// pinned to the first tick of the UTC day. An in-memory limiter cannot do
		// this: the worker builds a fresh layer per cron invocation, so any Ref it
		// holds starts empty on every tick.
		const SYNC_WINDOW_MS = 15 * 60 * 1000

		const paginateClerk = <T>(
			spanName: string,
			attributes: Readonly<Record<string, string>>,
			fetchPage: (params: {
				limit: number
				offset: number
			}) => Promise<{ data: T[]; totalCount: number }>,
			errorMessage: string,
		) =>
			Effect.gen(function* () {
				const PAGE_SIZE = 100
				let offset = 0
				const all: T[] = []

				// Genuine cursor pagination: each page advances `offset` by the
				// number of rows it returned, and the terminating condition depends
				// on the just-fetched page (totalCount / empty page). Effect v4
				// (beta) ships neither `iterate` nor `loop`, so an imperative
				// while-loop driving sequential `yield*`s is the clearest form here.
				while (true) {
					const page = yield* clerkRequest(spanName, attributes, () =>
						fetchPage({ limit: PAGE_SIZE, offset }),
					).pipe(Effect.mapError(() => new DigestPersistenceError({ message: errorMessage })))
					all.push(...page.data)
					offset += page.data.length
					if (offset >= page.totalCount || page.data.length === 0) break
				}

				return all
			})

		const fetchAllClerkMemberships = Effect.fn("DigestService.fetchAllClerkMemberships")(function* (
			clerk: ReturnType<typeof createClerkClient>,
		) {
			const orgs = yield* paginateClerk(
				"Clerk.organizations.getOrganizationList",
				{},
				(params) => clerk.organizations.getOrganizationList(params),
				"Failed to list Clerk organizations",
			)

			const perOrgMemberships = yield* Effect.forEach(orgs, (org) =>
				Effect.gen(function* () {
					const members = yield* paginateClerk(
						"Clerk.organizations.getOrganizationMembershipList",
						{ orgId: org.id },
						(params) =>
							clerk.organizations.getOrganizationMembershipList({
								organizationId: org.id,
								...params,
							}),
						`Failed to list Clerk members for org ${org.id}`,
					)

					return members.flatMap((member) => {
						const memberEmail = member.publicUserData?.identifier
						const memberUserId = member.publicUserData?.userId
						if (!memberEmail || !memberUserId) return []
						return [
							{
								orgId: OrgId.make(org.id),
								userId: UserId.make(memberUserId),
								email: memberEmail,
							},
						]
					})
				}),
			)

			return perOrgMemberships.flat()
		})

		const reconcileSubscriptions = Effect.fn("DigestService.reconcileSubscriptions")(function* (
			clerkMemberships: Array<{ orgId: OrgId; userId: UserId; email: string }>,
		) {
			const now = yield* Clock.currentTimeMillis

			// Upsert all current Clerk members (re-enables returning members, updates
			// email). `enabled` is recomputed from the stored opt-out rather than
			// forced true: a member who turned the digest off stays off, while one
			// this sweep disabled when they left the org comes back enabled.
			yield* Effect.forEach(
				clerkMemberships,
				(m) =>
					database
						.execute((db) =>
							db.run(
								PG.insertInto(DigestSubscriptions)
									.values({
										id: crypto.randomUUID(),
										orgId: m.orgId,
										userId: m.userId,
										email: m.email,
										enabled: true,
										dayOfWeek: 1,
										timezone: "UTC",
										createdAt: now,
										updatedAt: now,
									})
									.onConflictDoUpdate({
										target: ["orgId", "userId"],
										set: ($) => ({
											email: m.email,
											enabled: PG.asBoolean($.optedOutAt.isNull()),
											webAnalyticsEnabled: PG.asBoolean(
												$.webAnalyticsOptedOutAt.isNull(),
											),
											updatedAt: now,
										}),
									}),
							),
						)
						.pipe(Effect.mapError(toPersistenceError)),
				{ discard: true },
			)

			// Disable subscriptions for members no longer in any Clerk org
			const activeOrgIds = [...new Set(clerkMemberships.map((m) => m.orgId))]
			if (activeOrgIds.length === 0) return

			const existingSubs = yield* database
				.execute((db) =>
					db.run(
						PG.from(DigestSubscriptions)
							.select("id", "orgId", "userId")
							.where(($) => [PG.inList($.orgId, activeOrgIds)]),
					),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const activeKeys = new Set(clerkMemberships.map((m) => `${m.orgId}:${m.userId}`))
			const staleIds = existingSubs
				.filter((s) => !activeKeys.has(`${s.orgId}:${s.userId}`))
				.map((s) => s.id)

			if (staleIds.length > 0) {
				yield* database
					.execute((db) =>
						db.run(
							PG.update(DigestSubscriptions)
								.set({ enabled: false, webAnalyticsEnabled: false, updatedAt: now })
								.where(($) => [PG.inList($.id, staleIds)]),
						),
					)
					.pipe(Effect.mapError(toPersistenceError))

				yield* Effect.logInfo("Disabled stale digest subscriptions").pipe(
					Effect.annotateLogs({ count: staleIds.length }),
				)
			}
		})

		const ensureSubscriptions = Effect.fn("DigestService.ensureSubscriptions")(function* () {
			if (env.MAPLE_AUTH_MODE.toLowerCase() !== "clerk") return
			if (Option.isNone(env.CLERK_SECRET_KEY)) return

			const now = yield* Clock.currentTimeMillis
			if (now % 86_400_000 >= SYNC_WINDOW_MS) return

			const clerk = createClerkClient({
				secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
			})

			const memberships = yield* fetchAllClerkMemberships(clerk)
			yield* reconcileSubscriptions(memberships)

			yield* Effect.logInfo("Digest subscriptions synced from Clerk").pipe(
				Effect.annotateLogs({ memberCount: memberships.length }),
			)
		})

		const runDigestTick = Effect.fn("DigestService.runDigestTick")(function* () {
			if (!email.isConfigured) {
				return { sentCount: 0, errorCount: 0, skipped: true }
			}

			yield* ensureSubscriptions().pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("Failed to seed digest subscriptions").pipe(
								Effect.annotateLogs({ error: summarizeCause(cause) }),
							),
				),
			)

			const now = yield* Clock.currentTimeMillis
			const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
			const todayStartMs = now - (now % 86_400_000)
			const currentDayOfWeek = new Date(now).getUTCDay()

			const subs = yield* database
				.execute((db) =>
					db.run(
						PG.from(DigestSubscriptions)
							.select()
							.where(($) => [$.enabled.eq(true)]),
					),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const dueSubs = subs.filter(
				(s) =>
					s.dayOfWeek === currentDayOfWeek && (s.lastSentAt == null || s.lastSentAt < sevenDaysAgo),
			)

			if (dueSubs.length === 0) {
				return { sentCount: 0, errorCount: 0, skipped: false }
			}

			// Grouped by (org, scope) rather than by org: subscribers who asked for
			// the same slice still share one render and one set of warehouse
			// queries, while a differently-scoped subscriber gets their own.
			const byScope = Arr.groupBy(dueSubs, (s) =>
				scopeKey(s.orgId, {
					environments: parseScopeColumn(s.environmentsJson),
					namespaces: parseScopeColumn(s.namespacesJson),
				}),
			)

			const results = yield* Effect.forEach(
				Object.values(byScope),
				(orgSubs) => {
					// Every subscription in the group shares an org and a scope by
					// construction, so the first row speaks for all of them.
					const head = orgSubs[0]!
					const rawOrgId = head.orgId
					const scope: DigestScope = {
						environments: parseScopeColumn(head.environmentsJson),
						namespaces: parseScopeColumn(head.namespacesJson),
					}

					return Effect.gen(function* () {
						const orgId = OrgId.make(rawOrgId)
						const orgSubIds = orgSubs.map((s) => s.id)

						// Orgs whose warehouse rejected queries with an auth/config-class
						// error are parked (see warehouse-org-quarantine.ts). Checked before
						// the claim so a parked org isn't marked attempted for the day.
						if (yield* isOrgWarehouseQuarantined(edgeCache, rawOrgId)) {
							yield* Effect.logInfo("Skipping digest for org with quarantined warehouse").pipe(
								Effect.annotateLogs({ orgId: rawOrgId }),
							)
							return []
						}

						const claim = yield* database
							.execute((db) =>
								db.run(
									PG.update(DigestSubscriptions)
										.set({ lastAttemptedAt: now })
										.where(($) => [
											PG.inList($.id, orgSubIds),
											PG.or(
												$.lastAttemptedAt.isNull(),
												$.lastAttemptedAt.lt(todayStartMs),
											),
										])
										.returning("id"),
								),
							)
							.pipe(Effect.mapError(toPersistenceError))

						if (claim.length === 0) {
							yield* Effect.logInfo("Skipping digest org already attempted today").pipe(
								Effect.annotateLogs({
									orgId: rawOrgId,
									subscriptionCount: orgSubs.length,
								}),
							)
							return []
						}

						const claimedIds = new Set(claim.map((c) => c.id))
						const claimedSubs = orgSubs.filter((s) => claimedIds.has(s.id))

						if (claimedSubs.length < orgSubs.length) {
							yield* Effect.logInfo(
								"Skipping digest subscriptions already attempted today",
							).pipe(
								Effect.annotateLogs({
									orgId: rawOrgId,
									skippedCount: orgSubs.length - claimedSubs.length,
									claimedCount: claimedSubs.length,
								}),
							)
						}

						const props = yield* generateDigestData(orgId, scope)
						if (!hasDigestContent(props)) {
							yield* Effect.logInfo("Skipping digest for org with no data").pipe(
								Effect.annotateLogs({
									orgId: rawOrgId,
									subscriptionCount: orgSubs.length,
								}),
							)

							return []
						}
						const subject = deriveDigestStatus(props).subject

						const sendResults = yield* Effect.forEach(
							claimedSubs,
							(sub) =>
								Effect.gen(function* () {
									const links = unsubscribeLinks(linkConfig, "digest", sub.id)
									const html = yield* renderDigestHtml({
										...props,
										unsubscribeUrl: links.pageUrl,
									})
									yield* email.send(sub.email, subject, html, { headers: links.headers })
								}).pipe(
									Effect.tap(() =>
										Effect.gen(function* () {
											const lastSentAt = yield* Clock.currentTimeMillis
											yield* database.execute((db) =>
												db.run(
													PG.update(DigestSubscriptions)
														.set({ lastSentAt })
														.where(($) => [$.id.eq(sub.id)]),
												),
											)
										}).pipe(
											// The email is already sent — a failed bookkeeping write must
											// not surface as a send failure (lastAttemptedAt still blocks
											// same-day retries).
											Effect.catchCause((cause) =>
												Cause.hasInterruptsOnly(cause)
													? Effect.interrupt
													: Effect.logWarning(
															"Failed to record digest lastSentAt",
														).pipe(
															Effect.annotateLogs({
																subscriptionId: sub.id,
																orgId: rawOrgId,
																error: summarizeCause(cause),
															}),
														),
											),
										),
									),
									Effect.match({
										onSuccess: () => ({ sent: true }),
										onFailure: () => ({ sent: false }),
									}),
								),
							{ concurrency: 1 },
						)

						return sendResults
					}).pipe(
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.gen(function* () {
										const quarantined = yield* quarantineOnConfigClassCause(
											edgeCache,
											rawOrgId,
											cause,
											now,
										)
										if (quarantined) {
											yield* Effect.logInfo(
												"Org warehouse rejected queries with a config-class error; quarantined",
											).pipe(
												Effect.annotateLogs({
													orgId: rawOrgId,
													error: summarizeCause(cause),
												}),
											)
										} else {
											yield* Effect.logError("Digest failed for org").pipe(
												Effect.annotateLogs({
													orgId: rawOrgId,
													error: summarizeCause(cause),
												}),
											)
										}
										return orgSubs.map(() => ({ sent: false }))
									}),
						),
					)
				},
				{ concurrency: 1 },
			)

			const allResults = results.flat()
			const sentCount = allResults.filter((r) => r.sent).length
			const errorCount = allResults.filter((r) => !r.sent).length

			yield* Effect.annotateCurrentSpan("sentCount", sentCount)
			yield* Effect.annotateCurrentSpan("errorCount", errorCount)
			yield* Effect.annotateCurrentSpan("scopeCount", Object.keys(byScope).length)

			return { sentCount, errorCount, skipped: false }
		})

		return {
			getSubscription,
			upsertSubscription,
			deleteSubscription,
			unsubscribeByToken,
			// Exposed so the shape of a digest can be asserted directly rather than
			// through rendered HTML.
			generateDigestData,
			// Exposed so the Clerk sweep's effect on a subscriber's own choice can
			// be asserted without standing up a Clerk client.
			reconcileSubscriptions,
			preview,
			runDigestTick,
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(WarehouseQueryService.layer, EmailService.layer)),
	)
}

function rowToResponse(row: DigestSubscriptionRow): DigestSubscriptionResponse {
	return new DigestSubscriptionResponse({
		id: DigestSubscriptionId.make(row.id),
		email: row.email,
		enabled: row.enabled,
		dayOfWeek: row.dayOfWeek,
		timezone: row.timezone,
		namespaces: parseScopeColumn(row.namespacesJson),
		environments: parseScopeColumn(row.environmentsJson),
		lastSentAt: row.lastSentAt,
		webAnalyticsEnabled: row.webAnalyticsEnabled,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	})
}

function hasDigestContent(props: WeeklyDigestProps): boolean {
	return (
		props.summary.requests.value > 0 ||
		props.summary.errors.value > 0 ||
		props.summary.dataVolume.valueBytes > 0 ||
		props.ingestion.logs > 0 ||
		props.ingestion.traces > 0 ||
		props.ingestion.metrics > 0 ||
		props.ingestion.totalBytes > 0 ||
		props.services.some(
			(service) => service.requests > 0 || service.errorRate > 0 || service.p95Ms > 0,
		) ||
		props.topErrors.some((error) => error.count > 0)
	)
}
