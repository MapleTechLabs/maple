import {
	UserActivityResponse,
	UserIssuesResponse,
	UserLogsResponse,
	UserProfileResponse,
	UserTracesResponse,
	UsersFacetsResponse,
	UsersListResponse,
	type UserActivityItem,
	type UserDetailRequest,
	type UserEventItem,
	type UserIssueItem,
	type UserListItem,
	type UserLogItem,
	type UserMcpSessionItem,
	type UserProfileItem,
	type UserService,
	type UserSessionItem,
	type UserSignalKind,
	type UserTraceItem,
	type UsersFacetsRequest,
	type UsersListRequest,
} from "@maple/domain/http"
import { Array as Arr, Clock, DateTime, Effect, Option } from "effect"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { isMissingUserActivityHourly } from "@maple/backend/services/warehouse/missing-table"
import { readUserSessionsOnServer } from "@maple/backend/services/mcp/mcp-reads"
import { readUserIssueItems, readUserIssueTotalsRow, userIssueTotals } from "./user-issues"

// The users directory's reads (`/users`): the namespace scope is resolved to services first, since
// replays and product events carry only a service name, then the users queries run in parallel.
// Spans and logs come from `user_activity_hourly`; a BYO cluster without it (migration 0056) reads
// the other sources, and the per-user request numbers come back null or empty.

const USERS_READ_CONCURRENCY = 4
const DEFAULT_LIMIT = 200
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
/** Slices of the window the directory's activity bars and the profile's spark draw. */
export const ACTIVITY_BUCKETS = 7

type Window = Readonly<{ startTime: string; endTime: string; namespaces?: ReadonlyArray<string> }>
type ServiceNamespaceRow = Readonly<{ service: string; namespace: string }>

const nullIfEmpty = (value: string): string | null => (value === "" ? null : value)

/** Epoch ms of a warehouse DateTime, `0` for the empty aggregate over no rows. */
const toMs = (value: DateTime.Utc): number => Math.max(0, DateTime.toEpochMillis(value))

/**
 * The scope the users queries read: each service labelled with its busiest namespace (rows arrive
 * busiest first), and the services that emitted under any scoped namespace.
 */
export const resolveUsersScope = (
	namespaces: ReadonlyArray<string>,
	serviceRows: ReadonlyArray<ServiceNamespaceRow>,
	mcpServices: ReadonlyArray<string>,
): CH.UsersScope => {
	const primary = Arr.dedupeWith(serviceRows, (a, b) => a.service === b.service)
	const inScope = Arr.filter(serviceRows, (row) => namespaces.includes(row.namespace))
	return {
		namespaces,
		services: Arr.dedupe(Arr.map(inScope, (row) => row.service)),
		serviceNamespaces: Arr.map(primary, (row) => [row.service, row.namespace] as const),
		mcpServices,
	}
}

/** Which signals a merged user row holds; spans beyond the MCP ones are traces. */
export const signalsOf = (
	row: Readonly<{ sessions: number; events: number; mcpSpans: number; spans?: number; logLines?: number }>,
): ReadonlyArray<UserSignalKind> => [
	...(row.sessions > 0 ? ["replay" as const] : []),
	...(row.events > 0 ? ["events" as const] : []),
	...(row.mcpSpans > 0 ? ["mcp" as const] : []),
	...((row.spans ?? 0) > row.mcpSpans ? ["traces" as const] : []),
	...((row.logLines ?? 0) > 0 ? ["logs" as const] : []),
]

/**
 * Requests per hour (epoch seconds, as the rollup's `sumMap` returns them) in `buckets` equal slices
 * of the window, oldest first. An hour floored before the start lands in the first slice.
 */
export const bucketActivity = (
	hours: ReadonlyArray<number>,
	counts: ReadonlyArray<number>,
	window: Readonly<{ startMs: number; endMs: number }>,
	buckets: number = ACTIVITY_BUCKETS,
): ReadonlyArray<number> => {
	const span = Math.max(1, window.endMs - window.startMs)
	const empty: ReadonlyArray<number> = Arr.makeBy(buckets, () => 0)
	return Arr.reduce(Arr.zip(hours, counts), empty, (sums, [hour, count]) => {
		const offset = Math.floor(((hour * 1000 - window.startMs) * buckets) / span)
		const index = Math.min(buckets - 1, Math.max(0, offset))
		return Arr.map(sums, (sum, i) => (i === index ? sum + count : sum))
	})
}

const windowMs = (window: Readonly<{ startTime: string; endTime: string }>) => ({
	startMs: parseWarehouseDateTime(window.startTime),
	endMs: parseWarehouseDateTime(window.endTime),
})

/** A rollup read, `None` on a cluster that has not applied migration 0056. */
const rollupRead = <A, E, R>(read: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E, R> =>
	read.pipe(
		Effect.map(Option.some),
		Effect.catchIf(isMissingUserActivityHourly, () => Effect.succeed(Option.none<A>())),
	)

/** A read over every source with the rollup, again without it on a cluster missing migration 0056. */
const withRollupFallback = <A, E, R>(
	scope: CH.UsersScope,
	empty: A,
	read: (scope: CH.UsersScope) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	read({ ...scope, activityRollup: true }).pipe(
		Effect.catchIf(isMissingUserActivityHourly, () => {
			const without: CH.UsersScope = { ...scope, activityRollup: false }
			return CH.hasUserSources(without) ? read(without) : Effect.succeed(empty)
		}),
	)

const loadScope = Effect.fn("UsersReads.scope")(function* (tenant: TenantContext, window: Window) {
	const warehouse = yield* WarehouseQueryService
	const params = { orgId: tenant.orgId, startTime: window.startTime, endTime: window.endTime }
	const [serviceRows, mcpRows] = yield* Effect.all(
		[
			warehouse.compiledQuery(tenant, CH.compile(CH.usersServiceNamespacesQuery(), params), {
				profile: "list",
				context: "usersServiceNamespaces",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpServicesQuery(), params), {
				profile: "list",
				context: "mcpServices",
			}),
		],
		{ concurrency: 2 },
	)
	const mcpServices = Arr.map(
		Arr.filter(mcpRows, (row) => row.serverSpans > 0),
		(row) => row.service,
	)
	const scope = resolveUsersScope(window.namespaces ?? [], serviceRows, mcpServices)
	yield* Effect.annotateCurrentSpan({
		"maple.users.namespaces": scope.namespaces.length,
		"maple.users.scoped_services": scope.services.length,
		"maple.users.mcp_services": mcpServices.length,
	})
	return scope
})

export const readUsersList = Effect.fn("UsersReads.list")(function* (
	tenant: TenantContext,
	payload: UsersListRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	const scope = yield* loadScope(tenant, payload)
	const filter = {
		...(payload.search !== undefined && { search: payload.search }),
		...(payload.hasErrors !== undefined && { hasErrors: payload.hasErrors }),
		...(payload.hasReplay !== undefined && { hasReplay: payload.hasReplay }),
		...(payload.groups !== undefined && { groups: payload.groups }),
		...(payload.after !== undefined && { after: payload.after }),
	}
	const params = { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime }
	const limit = payload.limit ?? DEFAULT_LIMIT
	// One row of lookahead says whether a next page exists.
	const fetched = yield* withRollupFallback(scope, [], (scope) =>
		warehouse.compiledQuery(
			tenant,
			CH.compile(CH.usersListQuery(scope, filter, limit + 1, payload.offset ?? 0), params),
			{ profile: "list", context: "usersList" },
		),
	)
	const rows = fetched.slice(0, limit)
	const last = rows.at(-1)
	const next =
		fetched.length > limit && last !== undefined
			? { lastSeen: last.lastSeenKey, userId: last.userId }
			: undefined
	const totals =
		rows.length === 0
			? []
			: yield* rollupRead(
					warehouse.compiledQuery(
						tenant,
						CH.compile(
							CH.userActivityTotalsQuery({
								userIds: Arr.map(rows, (row) => row.userId),
								namespaces: scope.namespaces,
							}),
							params,
						),
						{ profile: "list", context: "userActivityTotals" },
					),
				).pipe(Effect.map((found) => Option.getOrElse(found, () => [])))
	const totalsByUser = new Map(Arr.map(totals, (row) => [row.userId, row] as const))
	const window = windowMs(payload)
	const users = Arr.map(rows, (row): UserListItem => {
		const total = totalsByUser.get(row.userId)
		return {
			userId: row.userId,
			name: nullIfEmpty(row.name),
			email: nullIfEmpty(row.email),
			groupId: nullIfEmpty(row.groupId),
			namespaces: row.namespaces,
			firstSeenMs: toMs(row.firstSeen),
			lastSeenMs: toMs(row.lastSeen),
			sessions: row.sessions,
			errors: row.errors,
			requests: row.requests,
			topRoute: total === undefined ? null : nullIfEmpty(total.topRoute),
			activity:
				total === undefined
					? []
					: bucketActivity(total.requestHours, total.requestHourCounts, window),
			signals: signalsOf(row),
		}
	})
	yield* Effect.annotateCurrentSpan({
		"maple.users.rows": users.length,
		"maple.users.with_requests": totals.length,
	})
	return new UsersListResponse({ users, ...(next !== undefined && { next }) })
})

const EMPTY_FACETS = new UsersFacetsResponse({
	namespaces: [],
	groups: [],
	withErrors: 0,
	withReplay: 0,
	identified: 0,
	activeToday: 0,
	anonymousVisitors: 0,
})

export const readUsersFacets = Effect.fn("UsersReads.facets")(function* (
	tenant: TenantContext,
	payload: UsersFacetsRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	const scope = yield* loadScope(tenant, payload)
	// The namespace facet counts every namespace, so a pick never hides the others; a pin hides it.
	const pinned = (payload.namespaces ?? []).length > 0
	const nowMs = yield* Clock.currentTimeMillis
	const params = {
		orgId: tenant.orgId,
		startTime: payload.startTime,
		endTime: payload.endTime,
		activeSince: formatWarehouseDateTime(nowMs - DAY_MS),
	}
	const read = (scope: CH.UsersScope) => {
		const everyNamespace: CH.UsersScope | undefined = pinned
			? undefined
			: { ...scope, namespaces: [], services: [] }
		return Effect.all(
			[
				warehouse.compiledQuery(
					tenant,
					CH.compileUnion(CH.usersFacetsQuery(scope, everyNamespace), params),
					{ profile: "aggregation", context: "usersFacets" },
				),
				warehouse.compiledQuery(tenant, CH.compile(CH.usersSummaryQuery(scope), params), {
					profile: "aggregation",
					context: "usersSummary",
				}),
				warehouse.compiledQuery(tenant, CH.compile(CH.usersAnonymousVisitorsQuery(scope), params), {
					profile: "aggregation",
					context: "usersAnonymousVisitors",
				}),
			],
			{ concurrency: USERS_READ_CONCURRENCY },
		)
	}
	const [facets, summary, anonymous] = yield* withRollupFallback(scope, [[], [], []], read)
	if (facets.length === 0 && summary.length === 0) return EMPTY_FACETS
	const options = (facetType: string) =>
		Arr.map(
			Arr.filter(facets, (row) => row.facetType === facetType),
			(row) => ({ name: row.name, count: row.count }),
		)
	const totals = summary[0]
	return new UsersFacetsResponse({
		namespaces: options("namespace"),
		groups: options("group"),
		withErrors: totals?.withErrors ?? 0,
		withReplay: totals?.withReplay ?? 0,
		identified: totals?.identified ?? 0,
		activeToday: totals?.activeToday ?? 0,
		anonymousVisitors: anonymous[0]?.anonymousVisitors ?? 0,
	})
})

// --- one user (`/users/$userId`) ----------------------------------------------------------------

/** Replay sessions, product events and MCP sessions one user page lists at most, each. */
const USER_LIST_LIMIT = 100
const USER_EVENTS_LIMIT = 200
/** Rows the merged Activity timeline keeps. */
const ACTIVITY_LIMIT = 200
/** MCP servers one user page reads sessions from at most. */
const MCP_SERVERS_LIMIT = 20
/** Properties an event's detail line names when it has no page. */
const EVENT_DETAIL_PROPERTIES = 3
/** Requests and log lines the Traces and Logs tabs list at most. */
const USER_TRACES_LIMIT = 100
const USER_LOGS_LIMIT = 200
/** Failed or slow requests, and warnings, the Activity timeline takes at most, each. */
const NOTABLE_LIMIT = 50
/** A request at least this slow is notable on the timeline. */
export const SLOW_REQUEST_MS = 2000
/** OTel SeverityNumber of WARN: the timeline keeps warnings and worse. */
const WARN_SEVERITY = 13
/** Characters of a log body a timeline row keeps. */
const LOG_TITLE_LENGTH = 200

/** The MCP servers in scope: every one when unscoped, else those that emitted under the namespace. */
export const mcpServersInScope = (scope: CH.UsersScope): ReadonlyArray<string> =>
	(scope.namespaces.length === 0
		? scope.mcpServices
		: Arr.filter(scope.mcpServices, (service) => scope.services.includes(service))
	).slice(0, MCP_SERVERS_LIMIT)

/** An event's detail line: its page, else its first properties as `key=value`. */
export const eventDetail = (
	pagePath: string,
	keys: ReadonlyArray<string>,
	values: ReadonlyArray<string>,
): string =>
	pagePath !== ""
		? pagePath
		: Arr.join(
				Arr.map(
					Arr.zip(keys, values).slice(0, EVENT_DETAIL_PROPERTIES),
					([key, value]) => `${key}=${value}`,
				),
				", ",
			)

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

/** What the timeline merges: the activity read's rows, and the notable requests and log lines. */
export type ActivitySources = Readonly<{
	sessions: ReadonlyArray<UserSessionItem>
	events: ReadonlyArray<UserEventItem>
	mcpSessions: ReadonlyArray<UserMcpSessionItem>
	traces?: ReadonlyArray<UserTraceItem>
	logs?: ReadonlyArray<UserLogItem>
	issues?: ReadonlyArray<UserIssueItem>
}>

const requestItem = (trace: UserTraceItem): UserActivityItem => {
	const failed = trace.status === "Error"
	return {
		kind: "request",
		atMs: trace.atMs,
		service: trace.service,
		title: trace.spanName,
		detail: Arr.join(
			[failed ? "Failed" : "Slow", `${Math.round(trace.durationMs)} ms`, trace.service],
			" · ",
		),
		tone: failed ? "crit" : "warn",
		sessionId: null,
		traceId: trace.traceId,
		issueId: null,
	}
}

const logItem = (log: UserLogItem): UserActivityItem => ({
	kind: "log",
	atMs: log.atMs,
	service: log.service,
	title: log.body.slice(0, LOG_TITLE_LENGTH),
	detail: Arr.join([log.severity, log.service], " · "),
	tone: isErrorSeverity(log.severity) ? "crit" : "warn",
	sessionId: null,
	traceId: nullIfEmpty(log.traceId),
	issueId: null,
})

/** An issue the user hit, at its latest occurrence in the window; it opens the issue page. */
const issueItem = (issue: UserIssueItem): UserActivityItem => ({
	kind: "error",
	atMs: issue.lastSeenMs,
	service: issue.service,
	title: issue.type === "" ? issue.message : issue.type,
	detail: Arr.join(
		Arr.filter(
			[plural(issue.hits, "hit"), issue.service, issue.type === "" ? "" : issue.message],
			(part) => part !== "",
		),
		" · ",
	),
	tone: "crit",
	sessionId: null,
	traceId: null,
	issueId: issue.issueId,
})

/**
 * The Activity tab: replay sessions, product events, MCP sessions, the issues the user hit, failed or
 * slow requests and warn/error logs as one timeline, the latest first, capped at `limit`. Failures are `crit`.
 */
export const mergeActivity = (
	sources: ActivitySources,
	limit: number = ACTIVITY_LIMIT,
): ReadonlyArray<UserActivityItem> =>
	[
		...Arr.map(sources.sessions, (session): UserActivityItem => ({
			kind: "session",
			atMs: session.startedMs,
			service: session.service,
			title: session.entryPath === "" ? "Session" : `Session on ${session.entryPath}`,
			detail: Arr.join(
				[
					plural(session.pages, "page"),
					plural(session.errors, "error"),
					...(session.device === "" ? [] : [session.device]),
				],
				" · ",
			),
			tone: session.errors > 0 ? "crit" : "neutral",
			sessionId: session.sessionId,
			traceId: null,
			issueId: null,
		})),
		...Arr.map(sources.events, (event): UserActivityItem => ({
			kind: "event",
			atMs: event.atMs,
			service: event.service,
			title: event.name,
			detail: Arr.join(
				Arr.filter([event.source, event.detail], (part) => part !== ""),
				" · ",
			),
			tone: "neutral",
			sessionId: null,
			traceId: null,
			issueId: null,
		})),
		...Arr.map(sources.mcpSessions, (session): UserActivityItem => ({
			kind: "mcp",
			atMs: session.firstSeenMs,
			service: session.service,
			title: `${plural(session.calls, "tool call")} from ${session.client}`,
			detail: Arr.join(
				[session.service, plural(session.tools, "tool"), `${session.errors} failed`],
				" · ",
			),
			tone: session.errors > 0 ? "crit" : "neutral",
			sessionId: session.sessionId,
			traceId: null,
			issueId: null,
		})),
		...Arr.map(sources.issues ?? [], issueItem),
		...Arr.map(sources.traces ?? [], requestItem),
		...Arr.map(sources.logs ?? [], logItem),
	]
		.toSorted((a, b) => b.atMs - a.atMs)
		.slice(0, limit)

const detailParams = (tenant: TenantContext, payload: UserDetailRequest) => ({
	orgId: tenant.orgId,
	startTime: payload.startTime,
	endTime: payload.endTime,
	userId: payload.userId,
})

const EMPTY_PROFILE = new UserProfileResponse({ profile: null })

/**
 * Services touched: the replay, event and MCP counts per (service, namespace) plus the rollup's
 * requests and log lines. MCP spans are requests in both, so an MCP server keeps the larger count.
 */
export const mergeServices = (
	signals: ReadonlyArray<UserService>,
	rollup: ReadonlyArray<CH.UserActivityServiceOutput>,
	mcpServices: ReadonlyArray<string>,
): ReadonlyArray<UserService> => {
	const keyOf = (service: string, namespace: string) => `${service}\u0000${namespace}`
	const merged = Arr.reduce(
		rollup,
		new Map(Arr.map(signals, (row) => [keyOf(row.service, row.namespace), row] as const)),
		(byKey, row) => {
			const key = keyOf(row.serviceName, row.serviceNamespace)
			const count = row.requestCount + row.logCount
			const known = byKey.get(key)?.signals ?? 0
			return byKey.set(key, {
				service: row.serviceName,
				namespace: row.serviceNamespace,
				signals: mcpServices.includes(row.serviceName) ? Math.max(known, count) : known + count,
			})
		},
	)
	return [...merged.values()].toSorted((a, b) => b.signals - a.signals)
}

export const readUserProfile = Effect.fn("UsersReads.profile")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	const scope = yield* loadScope(tenant, payload)
	const params = detailParams(tenant, payload)
	const readsServices = CH.readsServiceSources(scope)
	const readsMcp = scope.mcpServices.length > 0
	const userScope = { userId: payload.userId, namespaces: scope.namespaces }
	const [
		replay,
		devices,
		events,
		mcp,
		services,
		visitors,
		summary,
		rollupServices,
		totals,
		issues,
		issueTotalsRow,
	] = yield* Effect.all(
		[
			readsServices
				? warehouse.compiledQuery(tenant, CH.compile(CH.userReplayProfileQuery(scope), params), {
						profile: "aggregation",
						context: "userReplayProfile",
					})
				: Effect.succeed([]),
			readsServices
				? warehouse.compiledQuery(tenant, CH.compile(CH.userDevicesQuery(scope), params), {
						profile: "aggregation",
						context: "userDevices",
					})
				: Effect.succeed([]),
			readsServices
				? warehouse.compiledQuery(tenant, CH.compile(CH.userEventsSummaryQuery(scope), params), {
						profile: "aggregation",
						context: "userEventsSummary",
					})
				: Effect.succeed([]),
			readsMcp
				? warehouse.compiledQuery(tenant, CH.compile(CH.userMcpSummaryQuery(scope), params), {
						profile: "aggregation",
						context: "userMcpSummary",
					})
				: Effect.succeed([]),
			CH.hasUserSources(scope)
				? warehouse.compiledQuery(tenant, CH.compile(CH.userServicesQuery(scope), params), {
						profile: "aggregation",
						context: "userServices",
					})
				: Effect.succeed([]),
			warehouse.compiledQuery(tenant, CH.compile(CH.userVisitorIdsQuery(), params), {
				profile: "list",
				context: "userVisitorIds",
			}),
			rollupRead(
				warehouse.compiledQuery(tenant, CH.compile(CH.userActivitySummaryQuery(userScope), params), {
					profile: "aggregation",
					context: "userActivitySummary",
				}),
			),
			rollupRead(
				warehouse.compiledQuery(tenant, CH.compile(CH.userActivityServicesQuery(userScope), params), {
					profile: "aggregation",
					context: "userActivityServices",
				}),
			),
			rollupRead(
				warehouse.compiledQuery(
					tenant,
					CH.compile(
						CH.userActivityTotalsQuery({
							userIds: [payload.userId],
							namespaces: scope.namespaces,
						}),
						params,
					),
					{ profile: "aggregation", context: "userActivityTotals" },
				),
			),
			readUserIssueItems(tenant, payload),
			readUserIssueTotalsRow(tenant, payload),
		],
		{ concurrency: USERS_READ_CONCURRENCY },
	)
	const sessions = replay[0]?.sessions ?? 0
	const eventCount = events[0]?.events ?? 0
	const mcpRequests = mcp[0]?.requests ?? 0
	// `None` when the cluster has no rollup: the request figures are then unknown, not zero.
	const activity = Option.flatMap(summary, (rows) => Option.fromNullishOr(rows[0]))
	const spanCount = Option.match(activity, { onNone: () => 0, onSome: (row) => row.spanCount })
	const logCount = Option.match(activity, { onNone: () => 0, onSome: (row) => row.logCount })
	// `None` when `error_events` predates `UserId`: the issue figures are then unknown, not zero.
	const issueTotals = Option.flatMap(issues, (items) =>
		Option.map(issueTotalsRow, (row) => userIssueTotals(row, items.length)),
	)
	const hitCount = Option.match(issueTotals, { onNone: () => 0, onSome: (totals) => totals.hits })
	yield* Effect.annotateCurrentSpan({
		"maple.users.sessions": sessions,
		"maple.users.events": eventCount,
		"maple.users.mcp_requests": mcpRequests,
		"maple.users.spans": spanCount,
		"maple.users.logs": logCount,
		"maple.users.activity_rollup": Option.isSome(summary),
		"maple.users.issue_hits": hitCount,
	})
	if (
		sessions === 0 &&
		eventCount === 0 &&
		mcpRequests === 0 &&
		spanCount === 0 &&
		logCount === 0 &&
		hitCount === 0
	)
		return EMPTY_PROFILE
	// Each source's bounds, only from sources that saw the user (an empty aggregate is the epoch).
	const seen = [
		...(sessions > 0 && replay[0] !== undefined ? [replay[0]] : []),
		...(eventCount > 0 && events[0] !== undefined ? [events[0]] : []),
		...(mcpRequests > 0 && mcp[0] !== undefined ? [mcp[0]] : []),
		...Option.toArray(Option.filter(activity, (row) => row.spanCount + row.logCount > 0)),
	]
	const issueItems = Option.getOrElse(issues, () => [])
	const firstSeens = [
		...Arr.map(seen, (row) => toMs(row.firstSeen)),
		...Arr.map(issueItems, (item) => item.firstSeenMs),
	]
	const lastSeens = [
		...Arr.map(seen, (row) => toMs(row.lastSeen)),
		...Arr.map(issueItems, (item) => item.lastSeenMs),
	]
	const traitKeys = replay[0]?.traitKeys ?? []
	const traitValues = replay[0]?.traitValues ?? []
	const total = Option.flatMap(totals, (rows) => Option.fromNullishOr(rows[0]))
	const requestFigure = <A>(read: (row: CH.UserActivitySummaryOutput) => A): A | null =>
		Option.match(activity, {
			onNone: () => null,
			onSome: (row) => (row.requestCount === 0 ? null : read(row)),
		})
	const countFigure = (read: (row: CH.UserActivitySummaryOutput) => number): number | null =>
		Option.match(activity, { onNone: () => null, onSome: read })
	const profile: UserProfileItem = {
		userId: payload.userId,
		name: nullIfEmpty(replay[0]?.name ?? "") ?? nullIfEmpty(mcp[0]?.name ?? ""),
		email: nullIfEmpty(replay[0]?.email ?? "") ?? nullIfEmpty(mcp[0]?.email ?? ""),
		groupId: nullIfEmpty(replay[0]?.groupId ?? ""),
		traits: Arr.map(Arr.zip(traitKeys, traitValues), ([key, value]) => ({ key, value })),
		visitorIds: Arr.map(visitors, (row) => row.visitorId),
		firstSeenMs: Math.min(...firstSeens),
		lastSeenMs: Math.max(...lastSeens),
		sessions,
		recordedMs: replay[0]?.recordedMs ?? 0,
		replayErrors: replay[0]?.errors ?? 0,
		events: eventCount,
		distinctEvents: events[0]?.distinctEvents ?? 0,
		mcpRequests,
		mcpCalls: mcp[0]?.calls ?? 0,
		devices: Arr.map(devices, (row) => ({ browser: row.browser, os: row.os, sessions: row.sessions })),
		country: nullIfEmpty(replay[0]?.country ?? ""),
		services: mergeServices(
			Arr.map(services, (row) => ({
				service: row.service,
				namespace: row.namespace,
				signals: row.signals,
			})),
			Option.getOrElse(rollupServices, () => []),
			scope.mcpServices,
		),
		signals: signalsOf({
			sessions,
			events: eventCount,
			mcpSpans: mcpRequests,
			spans: spanCount,
			logLines: logCount,
		}),
		requests: countFigure((row) => row.requestCount),
		failedRate: requestFigure((row) => row.failedRequestCount / row.requestCount),
		p95Ms: requestFigure((row) => row.p95DurationMs),
		traces: countFigure((row) => row.traceCount),
		logs: countFigure((row) => row.logCount),
		issues: Option.getOrNull(Option.map(issueTotals, (totals) => totals.issues)),
		issueHits: Option.getOrNull(Option.map(issueTotals, (totals) => totals.hits)),
		topRoute: Option.getOrNull(
			Option.flatMap(total, (row) => Option.fromNullishOr(nullIfEmpty(row.topRoute))),
		),
		activity: Option.match(total, {
			onNone: () => [],
			onSome: (row) => bucketActivity(row.requestHours, row.requestHourCounts, windowMs(payload)),
		}),
	}
	return new UserProfileResponse({ profile })
})

const deviceOf = (browser: string, os: string): string =>
	Arr.join(
		Arr.filter([browser, os], (part) => part !== ""),
		" · ",
	)

// --- one user's spans and logs: rollup slices first, then a raw read pruned to them --------------

/** The services and window a user's raw rows can be in, as the raw reads take them. */
export type SliceWindow = Readonly<{
	serviceNames: ReadonlyArray<string>
	startTime: string
	endTime: string
}>

/**
 * The rollup slices that hold the signal, narrowed to the services they name and the hours they
 * span inside the request window; `null` when none does, so the raw read is skipped.
 */
export const sliceWindow = (
	slices: ReadonlyArray<Readonly<{ hour: DateTime.Utc; serviceName: string }>>,
	window: Readonly<{ startTime: string; endTime: string }>,
): SliceWindow | null => {
	if (!Arr.isReadonlyArrayNonEmpty(slices)) return null
	const hours = Arr.map(slices, (slice) => DateTime.toEpochMillis(slice.hour))
	const { startMs, endMs } = windowMs(window)
	return {
		serviceNames: Arr.dedupe(Arr.map(slices, (slice) => slice.serviceName)),
		startTime: formatWarehouseDateTime(Math.max(startMs, Math.min(...hours))),
		endTime: formatWarehouseDateTime(Math.min(endMs, Math.max(...hours) + HOUR_MS - 1000)),
	}
}

/** The user's rollup slices in the namespace scope; none on a cluster without the rollup. */
const readSlices = Effect.fn("UsersReads.slices")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
) {
	const warehouse = yield* WarehouseQueryService
	const slices = yield* rollupRead(
		warehouse.compiledQuery(
			tenant,
			CH.compile(
				CH.userActivitySlicesQuery({ userId: payload.userId, namespaces: payload.namespaces ?? [] }),
				{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
			),
			{ profile: "list", context: "userActivitySlices" },
		),
	)
	yield* Effect.annotateCurrentSpan({
		"maple.users.activity_rollup": Option.isSome(slices),
		"maple.users.slices": Option.match(slices, { onNone: () => 0, onSome: (rows) => rows.length }),
	})
	return Option.getOrElse(slices, () => [])
})

const SEVERITY_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const

/** The SDK's severity text, else the OTel level of its number (1-4 TRACE ... 21-24 FATAL). */
export const severityOf = (text: string, number: number): string =>
	text !== ""
		? text
		: number < 1
			? "UNSPECIFIED"
			: (SEVERITY_LEVELS[Math.min(5, Math.floor((number - 1) / 4))] ?? "FATAL")

const isErrorSeverity = (severity: string): boolean =>
	["ERROR", "FATAL", "CRITICAL", "EMERGENCY", "ALERT"].includes(severity.toUpperCase())

const toTraceItem = (row: CH.UserTraceOutput): UserTraceItem => ({
	traceId: row.traceId,
	spanId: row.spanId,
	atMs: toMs(row.timestamp),
	spanName: row.spanName,
	service: row.serviceName,
	durationMs: row.durationMs,
	status: row.statusCode,
	isRoot: row.isRoot === 1,
})

const toLogItem = (row: CH.UserLogOutput): UserLogItem => ({
	atMs: toMs(row.timestamp),
	severity: severityOf(row.severityText, row.severityNumber),
	service: row.serviceName,
	body: row.body,
	traceId: row.traceId,
})

type RawReadOptions = Readonly<{ limit: number; notable: boolean }>

const readTraceRows = Effect.fn("UsersReads.traceRows")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
	slices: ReadonlyArray<CH.UserActivitySliceOutput>,
	options: RawReadOptions,
) {
	const window = sliceWindow(
		Arr.filter(slices, (slice) => slice.requestCount > 0),
		payload,
	)
	if (window === null) return []
	const warehouse = yield* WarehouseQueryService
	const rows = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(
			CH.userTracesQuery({
				userId: payload.userId,
				namespaces: payload.namespaces ?? [],
				serviceNames: window.serviceNames,
				limit: options.limit,
				...(options.notable && { notableSlowerThanMs: SLOW_REQUEST_MS }),
			}),
			{ orgId: tenant.orgId, startTime: window.startTime, endTime: window.endTime },
		),
		{ profile: "list", context: options.notable ? "userNotableTraces" : "userTraces" },
	)
	return Arr.map(rows, toTraceItem)
})

const readLogRows = Effect.fn("UsersReads.logRows")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
	slices: ReadonlyArray<CH.UserActivitySliceOutput>,
	options: RawReadOptions,
) {
	const window = sliceWindow(
		Arr.filter(slices, (slice) => slice.logCount > 0),
		payload,
	)
	if (window === null) return []
	const warehouse = yield* WarehouseQueryService
	const rows = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(
			CH.userLogsQuery({
				userId: payload.userId,
				namespaces: payload.namespaces ?? [],
				serviceNames: window.serviceNames,
				limit: options.limit,
				...(options.notable && { minSeverity: WARN_SEVERITY }),
			}),
			{ orgId: tenant.orgId, startTime: window.startTime, endTime: window.endTime },
		),
		{ profile: "list", context: options.notable ? "userNotableLogs" : "userLogs" },
	)
	return Arr.map(rows, toLogItem)
})

/** The Traces tab: the user's requests, newest first, read only where the rollup saw them. */
export const readUserTraces = Effect.fn("UsersReads.traces")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
) {
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	const slices = yield* readSlices(tenant, payload)
	const traces = yield* readTraceRows(tenant, payload, slices, { limit: USER_TRACES_LIMIT, notable: false })
	yield* Effect.annotateCurrentSpan({ "maple.users.traces": traces.length })
	return new UserTracesResponse({ traces })
})

/** The Logs tab: the user's log lines, newest first, read only where the rollup saw them. */
export const readUserLogs = Effect.fn("UsersReads.logs")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
) {
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	const slices = yield* readSlices(tenant, payload)
	const logs = yield* readLogRows(tenant, payload, slices, { limit: USER_LOGS_LIMIT, notable: false })
	yield* Effect.annotateCurrentSpan({ "maple.users.logs": logs.length })
	return new UserLogsResponse({ logs })
})

/** The timeline's failed or slow requests and warn/error log lines. */
const readNotable = Effect.fn("UsersReads.notable")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
) {
	const slices = yield* readSlices(tenant, payload)
	const options = { limit: NOTABLE_LIMIT, notable: true }
	return yield* Effect.all(
		[readTraceRows(tenant, payload, slices, options), readLogRows(tenant, payload, slices, options)],
		{ concurrency: 2 },
	)
})

export const readUserActivity = Effect.fn("UsersReads.activity")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	const scope = yield* loadScope(tenant, payload)
	const params = detailParams(tenant, payload)
	const readsServices = CH.readsServiceSources(scope)
	const servers = mcpServersInScope(scope)
	const window = { startTime: payload.startTime, endTime: payload.endTime }
	const [replays, eventRows, mcpSessions, [notableTraces, notableLogs], issues] = yield* Effect.all(
		[
			readsServices
				? warehouse.compiledQuery(
						tenant,
						CH.compile(
							CH.sessionReplaysListQuery({
								userId: payload.userId,
								...(scope.namespaces.length > 0 && { serviceNames: scope.services }),
								limit: USER_LIST_LIMIT,
							}),
							params,
						),
						{ profile: "list", context: "userSessions" },
					)
				: Effect.succeed([]),
			readsServices
				? warehouse.compiledQuery(
						tenant,
						CH.compile(CH.userEventsQuery(scope, USER_EVENTS_LIMIT), params),
						{ profile: "list", context: "userEvents" },
					)
				: Effect.succeed([]),
			Effect.map(
				Effect.forEach(
					servers,
					(service) =>
						Effect.map(
							readUserSessionsOnServer(
								tenant,
								window,
								service,
								payload.userId,
								USER_LIST_LIMIT,
							),
							Arr.map((session): UserMcpSessionItem => ({
								service,
								sessionId: session.sessionId,
								source: session.source,
								client: session.client,
								kind: session.kind,
								requests: session.requests,
								calls: session.calls,
								errors: session.errors,
								tools: session.tools,
								firstSeenMs: session.firstSeenMs,
								lastSeenMs: session.lastSeenMs,
							})),
						),
					{ concurrency: USERS_READ_CONCURRENCY },
				),
				(perServer) =>
					Arr.flatten(perServer)
						.toSorted((a, b) => b.lastSeenMs - a.lastSeenMs)
						.slice(0, USER_LIST_LIMIT),
			),
			readNotable(tenant, payload),
			readUserIssueItems(tenant, payload),
		],
		{ concurrency: 4 },
	)
	const sessions = Arr.map(replays, (row): UserSessionItem => {
		const startedMs = toMs(row.startTime)
		const lastMs = row.lastActivityAt === null ? startedMs : toMs(row.lastActivityAt)
		return {
			sessionId: row.sessionId,
			service: row.serviceName,
			startedMs,
			durationMs: row.durationMs ?? Math.max(0, lastMs - startedMs),
			pages: row.pageViews,
			errors: row.errorCount,
			entryPath: row.entryPath,
			device: deviceOf(row.browserName, row.osName),
		}
	})
	const events = Arr.map(eventRows, (row): UserEventItem => ({
		atMs: toMs(row.timestamp),
		name: row.name,
		source: row.source,
		service: row.service,
		detail: eventDetail(row.pagePath, row.propertyKeys, row.propertyValues),
	}))
	yield* Effect.annotateCurrentSpan({
		"maple.users.sessions": sessions.length,
		"maple.users.events": events.length,
		"maple.users.mcp_sessions": mcpSessions.length,
		"maple.users.mcp_servers": servers.length,
		"maple.users.notable_requests": notableTraces.length,
		"maple.users.notable_logs": notableLogs.length,
	})
	return new UserActivityResponse({
		sessions,
		events,
		mcpSessions,
		activity: mergeActivity({
			sessions,
			events,
			mcpSessions,
			traces: notableTraces,
			logs: notableLogs,
			issues: Option.getOrElse(issues, () => []),
		}),
	})
})

/** The Errors tab: the issues the user hit, most hits first; unattributed on an older cluster. */
export const readUserIssues = Effect.fn("UsersReads.issues")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
) {
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	const issues = yield* readUserIssueItems(tenant, payload)
	return new UserIssuesResponse({
		issues: Option.getOrElse(issues, () => []),
		attributed: Option.isSome(issues),
	})
})
