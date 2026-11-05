import {
	UserActivityResponse,
	UserProfileResponse,
	UsersFacetsResponse,
	UsersListResponse,
	type UserActivityItem,
	type UserDetailRequest,
	type UserEventItem,
	type UserListItem,
	type UserMcpSessionItem,
	type UserProfileItem,
	type UserSessionItem,
	type UserSignalKind,
	type UsersFacetsRequest,
	type UsersListRequest,
} from "@maple/domain/http"
import { Array as Arr, Clock, DateTime, Effect } from "effect"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { readUserSessionsOnServer } from "@maple/backend/services/mcp/mcp-reads"

// The users directory's reads (`/users`): the namespace scope is resolved to services first, since
// replays and product events carry only a service name, then the users queries run in parallel.

const USERS_READ_CONCURRENCY = 4
const DEFAULT_LIMIT = 200
const DAY_MS = 24 * 60 * 60 * 1000

type Window = Readonly<{ startTime: string; endTime: string; namespaces?: ReadonlyArray<string> }>
type ServiceNamespaceRow = Readonly<{ service: string; namespace: string }>

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

/** Which signals a merged user row holds. */
export const signalsOf = (
	row: Readonly<{ sessions: number; events: number; mcpSpans: number }>,
): ReadonlyArray<UserSignalKind> => [
	...(row.sessions > 0 ? ["replay" as const] : []),
	...(row.events > 0 ? ["events" as const] : []),
	...(row.mcpSpans > 0 ? ["mcp" as const] : []),
]

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
	if (!CH.hasUserSources(scope)) return new UsersListResponse({ users: [] })
	const filter = {
		...(payload.search !== undefined && { search: payload.search }),
		...(payload.hasErrors !== undefined && { hasErrors: payload.hasErrors }),
		...(payload.hasReplay !== undefined && { hasReplay: payload.hasReplay }),
		...(payload.groups !== undefined && { groups: payload.groups }),
	}
	const rows = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(CH.usersListQuery(scope, filter, payload.limit ?? DEFAULT_LIMIT), {
			orgId: tenant.orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
		{ profile: "list", context: "usersList" },
	)
	const users = Arr.map(rows, (row): UserListItem => ({
		userId: row.userId,
		name: row.name === "" ? null : row.name,
		email: row.email === "" ? null : row.email,
		groupId: row.groupId === "" ? null : row.groupId,
		namespaces: row.namespaces,
		firstSeenMs: toMs(row.firstSeen),
		lastSeenMs: toMs(row.lastSeen),
		sessions: row.sessions,
		errors: row.errors,
		requests: row.requests,
		signals: signalsOf(row),
	}))
	yield* Effect.annotateCurrentSpan({ "maple.users.rows": users.length })
	return new UsersListResponse({ users })
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
	const everyNamespace: CH.UsersScope | undefined = pinned
		? undefined
		: { ...scope, namespaces: [], services: [] }
	if (!CH.hasUserSources(scope)) return EMPTY_FACETS
	const nowMs = yield* Clock.currentTimeMillis
	const params = {
		orgId: tenant.orgId,
		startTime: payload.startTime,
		endTime: payload.endTime,
		activeSince: formatWarehouseDateTime(nowMs - DAY_MS),
	}
	const [facets, summary, anonymous] = yield* Effect.all(
		[
			warehouse.compiledQuery(
				tenant,
				CH.compileUnion(CH.usersFacetsQuery(scope, everyNamespace), params),
				{
					profile: "aggregation",
					context: "usersFacets",
				},
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

const nullIfEmpty = (value: string): string | null => (value === "" ? null : value)

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

/**
 * The Activity tab: replay sessions, product events and MCP sessions as one timeline, the latest
 * first, capped at `limit`. Rows with failures are marked `crit`.
 */
export const mergeActivity = (
	sessions: ReadonlyArray<UserSessionItem>,
	events: ReadonlyArray<UserEventItem>,
	mcpSessions: ReadonlyArray<UserMcpSessionItem>,
	limit: number = ACTIVITY_LIMIT,
): ReadonlyArray<UserActivityItem> =>
	[
		...Arr.map(sessions, (session): UserActivityItem => ({
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
		})),
		...Arr.map(events, (event): UserActivityItem => ({
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
		})),
		...Arr.map(mcpSessions, (session): UserActivityItem => ({
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
		})),
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

export const readUserProfile = Effect.fn("UsersReads.profile")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	const scope = yield* loadScope(tenant, payload)
	if (!CH.hasUserSources(scope)) return EMPTY_PROFILE
	const params = detailParams(tenant, payload)
	const readsServices = CH.readsServiceSources(scope)
	const readsMcp = scope.mcpServices.length > 0
	const [replay, devices, events, mcp, services, visitors] = yield* Effect.all(
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
			warehouse.compiledQuery(tenant, CH.compile(CH.userServicesQuery(scope), params), {
				profile: "aggregation",
				context: "userServices",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.userVisitorIdsQuery(), params), {
				profile: "list",
				context: "userVisitorIds",
			}),
		],
		{ concurrency: USERS_READ_CONCURRENCY },
	)
	const sessions = replay[0]?.sessions ?? 0
	const eventCount = events[0]?.events ?? 0
	const mcpRequests = mcp[0]?.requests ?? 0
	yield* Effect.annotateCurrentSpan({
		"maple.users.sessions": sessions,
		"maple.users.events": eventCount,
		"maple.users.mcp_requests": mcpRequests,
	})
	if (sessions === 0 && eventCount === 0 && mcpRequests === 0) return EMPTY_PROFILE
	// Each source's bounds, only from sources that saw the user (an empty aggregate is the epoch).
	const seen = [
		...(sessions > 0 && replay[0] !== undefined ? [replay[0]] : []),
		...(eventCount > 0 && events[0] !== undefined ? [events[0]] : []),
		...(mcpRequests > 0 && mcp[0] !== undefined ? [mcp[0]] : []),
	]
	const firstSeens = Arr.map(seen, (row) => toMs(row.firstSeen))
	const lastSeens = Arr.map(seen, (row) => toMs(row.lastSeen))
	const traitKeys = replay[0]?.traitKeys ?? []
	const traitValues = replay[0]?.traitValues ?? []
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
		services: Arr.map(services, (row) => ({
			service: row.service,
			namespace: row.namespace,
			signals: row.signals,
		})),
		signals: signalsOf({ sessions, events: eventCount, mcpSpans: mcpRequests }),
		requests: null,
		failedRate: null,
		p95Ms: null,
		traces: null,
		logs: null,
		issues: null,
	}
	return new UserProfileResponse({ profile })
})

const deviceOf = (browser: string, os: string): string =>
	Arr.join(
		Arr.filter([browser, os], (part) => part !== ""),
		" · ",
	)

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
	const [replays, eventRows, mcpSessions] = yield* Effect.all(
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
		],
		{ concurrency: 3 },
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
	})
	return new UserActivityResponse({
		sessions,
		events,
		mcpSessions,
		activity: mergeActivity(sessions, events, mcpSessions),
	})
})
