import {
	UsersFacetsResponse,
	UsersListResponse,
	type UserListItem,
	type UserSignalKind,
	type UsersFacetsRequest,
	type UsersListRequest,
} from "@maple/domain/http"
import { Array as Arr, Clock, DateTime, Effect } from "effect"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

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
