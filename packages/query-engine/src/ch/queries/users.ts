// End users (`/users`): one row per user id the SDKs identified, from session replays, product
// events and MCP server spans. Replays and events carry only a service name, so the caller resolves
// the namespace scope to service names and passes each service's namespace for the row label.

import * as T from "@maple-dev/effect-orm/clickhouse"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, fromQuery, fromUnion, param, unionAll } from "@maple-dev/effect-orm/clickhouse"
import { ProductEvents, SessionReplays, Traces, orgIdParam } from "../tables"
import { method as mcpMethod, userId as mcpUserId } from "./mcp"
import { serviceOverviewWindows } from "./services"
import { Array as Arr } from "effect"

/** Where the users' signals may come from. */
export interface UsersScope {
	/** The namespaces in effect (the org pin, else the rail's picks); empty is every namespace. */
	readonly namespaces: ReadonlyArray<string>
	/** The services that emitted under a scoped namespace: the scope of replays and events. */
	readonly services: ReadonlyArray<string>
	/** Each service's namespace, labelling replay and event rows. */
	readonly serviceNamespaces: ReadonlyArray<readonly [service: string, namespace: string]>
	/** Services answering MCP requests; MCP spans are only read from these (an unscoped scan times out). */
	readonly mcpServices: ReadonlyArray<string>
}

/** The directory's filters, applied per user after every source is merged. */
export interface UsersListFilter {
	/** Case-insensitive substring of the user id, name or email. */
	readonly search?: string
	readonly hasErrors?: boolean
	readonly hasReplay?: boolean
	readonly groups?: ReadonlyArray<string>
}

const likeLiteral = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Any non-empty value in the group, `''` when none. */
const nonEmpty = (value: CH.Expr<string>) => CH.anyIf(value, value.neq(""))

const zero = () => CH.toUInt64(CH.lit(0))

/** A service's namespace from the caller's map, `''` for a service it does not know. */
const namespaceOf = (service: CH.Expr<string>, scope: UsersScope): CH.Expr<string> =>
	scope.serviceNamespaces.length === 0
		? CH.lit("")
		: CH.compileTypedFnCall(
				"transform",
				T.string.schema,
				service,
				CH.arrayOf(...Arr.map(scope.serviceNamespaces, ([service]) => CH.lit(service))),
				CH.arrayOf(...Arr.map(scope.serviceNamespaces, ([, namespace]) => CH.lit(namespace))),
				CH.lit(""),
			)

/** Replays and events are in scope when unscoped or some service resolved; else they are skipped. */
const readsServiceSources = (scope: UsersScope): boolean =>
	scope.namespaces.length === 0 || scope.services.length > 0

const serviceScope = (service: CH.Expr<string>, scope: UsersScope) =>
	scope.namespaces.length === 0 ? undefined : CH.inList(service, scope.services)

/** Whether any source can hold a user under this scope; when not, every users query is empty. */
export const hasUserSources = (scope: UsersScope): boolean =>
	readsServiceSources(scope) || scope.mcpServices.length > 0

/** One session per row, each field finalized to its latest version (a ReplacingMergeTree). */
const replaySessions = (scope: UsersScope) =>
	from(SessionReplays)
		.select(($) => ({
			sessionId: $.SessionId,
			userId: CH.argMax($.UserId, $.Version),
			userName: CH.argMax($.UserName, $.Version),
			userEmail: CH.argMax($.UserEmail, $.Version),
			groupId: CH.argMax($.GroupId, $.Version),
			serviceName: CH.any_($.ServiceName),
			errors: CH.max_($.ErrorCount),
			startTime: CH.min_($.StartTime),
			lastActivity: CH.max_(CH.ifNull($.LastActivityAt, $.StartTime)),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.StartTime.gte(param.dateTime("startTime")),
			$.StartTime.lte(param.dateTime("endTime")),
			serviceScope($.ServiceName, scope),
		])
		.groupBy("sessionId")

// Every source answers the same columns in the same order: UNION ALL is positional.

const replayUsers = (scope: UsersScope) =>
	fromQuery(replaySessions(scope), "sessions")
		.select(($) => ({
			userId: $.userId,
			name: nonEmpty($.userName),
			email: nonEmpty($.userEmail),
			groupId: nonEmpty($.groupId),
			namespace: namespaceOf($.serviceName, scope),
			firstSeen: CH.min_($.startTime),
			lastSeen: CH.max_($.lastActivity),
			sessions: CH.count(),
			errors: CH.toUInt64(CH.sum($.errors)),
			requests: zero(),
			mcpSpans: zero(),
			events: zero(),
		}))
		.where(($) => [$.userId.neq("")])
		.groupBy("userId", "namespace")

const eventUsers = (scope: UsersScope) =>
	from(ProductEvents)
		.select(($) => ({
			userId: $.UserId,
			name: CH.lit(""),
			email: CH.lit(""),
			groupId: nonEmpty($.GroupId),
			namespace: namespaceOf($.ServiceName, scope),
			firstSeen: CH.min_($.Timestamp),
			lastSeen: CH.max_($.Timestamp),
			sessions: zero(),
			errors: zero(),
			requests: zero(),
			mcpSpans: zero(),
			events: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.UserId.neq(""),
			serviceScope($.ServiceName, scope),
		])
		.groupBy("userId", "namespace")

/** MCP server spans from a known user: `user.id`, else `enduser.id`; a request is a tool call. */
const mcpUsers = (scope: UsersScope) =>
	from(Traces)
		.select(($) => ({
			userId: mcpUserId($),
			name: nonEmpty($.SpanAttributes.get("user.name")),
			email: nonEmpty($.SpanAttributes.get("user.email")),
			groupId: CH.lit(""),
			namespace: $.ResourceAttributes.get("service.namespace"),
			firstSeen: CH.min_($.Timestamp),
			lastSeen: CH.max_($.Timestamp),
			sessions: zero(),
			errors: zero(),
			requests: CH.countIf(mcpMethod($).eq("tools/call")),
			mcpSpans: CH.count(),
			events: zero(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.SpanKind.eq("Server"),
			CH.inList($.ServiceName, scope.mcpServices),
			mcpMethod($).neq(""),
			mcpUserId($).neq(""),
			scope.namespaces.length === 0
				? undefined
				: CH.inList($.ResourceAttributes.get("service.namespace"), scope.namespaces),
		])
		.groupBy("userId", "namespace")

/** Every source's rows per (user, namespace). Callers check {@link hasUserSources} first. */
const userSignals = (scope: UsersScope) => {
	const [first, ...rest] = [
		...(readsServiceSources(scope) ? [replayUsers(scope), eventUsers(scope)] : []),
		...(scope.mcpServices.length > 0 ? [mcpUsers(scope)] : []),
	]
	return fromUnion(unionAll(first ?? replayUsers(scope), ...rest), "signals")
}

/** The directory: one row per user under the filter, the most recently seen first. */
export function usersListQuery(scope: UsersScope, filter: UsersListFilter = {}, limit = 200) {
	return userSignals(scope)
		.select(($) => ({
			userId: $.userId,
			name: nonEmpty($.name),
			email: nonEmpty($.email),
			groupId: nonEmpty($.groupId),
			namespaces: CH.arraySort(CH.groupUniqArrayIf(20)($.namespace, $.namespace.neq(""))),
			firstSeen: CH.min_($.firstSeen),
			lastSeen: CH.max_($.lastSeen),
			sessions: CH.sum($.sessions),
			errors: CH.sum($.errors),
			requests: CH.sum($.requests),
			mcpSpans: CH.sum($.mcpSpans),
			events: CH.sum($.events),
		}))
		.groupBy("userId")
		.having(($) => [
			CH.when(filter.hasErrors === true ? true : undefined, () => CH.sum($.errors).gt(0)),
			CH.when(filter.hasReplay === true ? true : undefined, () => CH.sum($.sessions).gt(0)),
			filter.groups !== undefined && filter.groups.length > 0
				? CH.inList(nonEmpty($.groupId), filter.groups)
				: undefined,
			CH.when(filter.search, (search) => {
				const pattern = `%${likeLiteral(search)}%`
				return $.userId
					.ilike(pattern)
					.or(nonEmpty($.name).ilike(pattern))
					.or(nonEmpty($.email).ilike(pattern))
			}),
		])
		.orderBy(["lastSeen", "desc"])
		.limit(limit)
		.format("JSON")
}

/**
 * Users per namespace and per group, as `(name, count, facetType)`. Without `namespaceScope` (a
 * pinned scope) the namespace facet is skipped.
 */
export function usersFacetsQuery(scope: UsersScope, namespaceScope?: UsersScope) {
	const groups = userSignals(scope)
		.select(($) => ({
			name: $.groupId,
			count: CH.uniqExact($.userId),
			facetType: CH.lit("group"),
		}))
		.where(($) => [$.groupId.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)
	if (namespaceScope === undefined) return unionAll(groups).format("JSON")
	const namespaces = userSignals(namespaceScope)
		.select(($) => ({
			name: $.namespace,
			count: CH.uniqExact($.userId),
			facetType: CH.lit("namespace"),
		}))
		.where(($) => [$.namespace.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)
	return unionAll(namespaces, groups).format("JSON")
}

/** The header's totals over the scope: users, those active since `activeSince`, with errors, with a replay. */
export function usersSummaryQuery(scope: UsersScope) {
	const perUser = userSignals(scope)
		.select(($) => ({
			userId: $.userId,
			lastSeen: CH.max_($.lastSeen),
			sessions: CH.sum($.sessions),
			errors: CH.sum($.errors),
		}))
		.groupBy("userId")
	return fromQuery(perUser, "users")
		.select(($) => ({
			identified: CH.count(),
			activeToday: CH.countIf($.lastSeen.gte(param.dateTime("activeSince"))),
			withErrors: CH.countIf($.errors.gt(0)),
			withReplay: CH.countIf($.sessions.gt(0)),
		}))
		.format("JSON")
}

/** Visitors in the window that never carried a user id, from replays and product events. */
export function usersAnonymousVisitorsQuery(scope: UsersScope) {
	const replays = from(SessionReplays)
		.select(($) => ({ visitorId: $.VisitorId, identified: CH.countIf($.UserId.neq("")) }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.StartTime.gte(param.dateTime("startTime")),
			$.StartTime.lte(param.dateTime("endTime")),
			$.VisitorId.neq(""),
			serviceScope($.ServiceName, scope),
		])
		.groupBy("visitorId")
	const events = from(ProductEvents)
		.select(($) => ({ visitorId: $.VisitorId, identified: CH.countIf($.UserId.neq("")) }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.VisitorId.neq(""),
			serviceScope($.ServiceName, scope),
		])
		.groupBy("visitorId")
	const visitors = fromUnion(unionAll(replays, events), "visitors")
		.select(($) => ({ visitorId: $.visitorId, identified: CH.sum($.identified) }))
		.groupBy("visitorId")
		.having(($) => [CH.sum($.identified).eq(0)])
	return fromQuery(visitors, "anonymous")
		.select(() => ({ anonymousVisitors: CH.count() }))
		.format("JSON")
}

/** Each service's namespaces in the window, busiest first, from the service overview rollups. */
export function usersServiceNamespacesQuery() {
	return serviceOverviewWindows({})
		.select(($) => ({
			service: $.bServiceName,
			namespace: $.bServiceNamespace,
			spans: CH.sum($.bSpanCount),
		}))
		.where(($) => [$.bServiceName.neq(""), $.bServiceNamespace.neq("")])
		.groupBy("service", "namespace")
		.orderBy(["spans", "desc"])
		.limit(2_000)
		.format("JSON")
}
