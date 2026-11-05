// End users (`/users`): one row per user id, from replays, product events, MCP server spans and
// `user_activity_hourly`. Replays and events carry only a service name (browser events not even
// that), so the caller resolves the namespace scope to services.

import * as T from "@maple-dev/effect-orm/clickhouse"
import * as CH from "@maple-dev/effect-orm/expr"
import {
	from,
	fromQuery,
	fromUnion,
	inSubquery,
	param,
	unionAll,
	type ColumnAccessor,
} from "@maple-dev/effect-orm/clickhouse"
import {
	IdentityLinks,
	ProductEvents,
	SessionReplays,
	Traces,
	UserActivityHourly,
	orgIdParam,
} from "../tables"
import { method as mcpMethod, userId as mcpUserId } from "./mcp"
import { utcHourFloor } from "./query-helpers"
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
	/** Read `user_activity_hourly` (spans and logs with `user.id`); off on a cluster without migration 0056. */
	readonly activityRollup?: boolean
}

/** The directory's filters, applied per user after every source is merged. */
export interface UsersListFilter {
	/** Case-insensitive substring of the user id, name or email. */
	readonly search?: string
	readonly hasErrors?: boolean
	readonly hasReplay?: boolean
	readonly groups?: ReadonlyArray<string>
}

/**
 * Case-insensitive substring match. Not `ILIKE`: an `OR` of LIKEs over aggregates in HAVING trips
 * `optimize_or_like_chain` (on by default since ClickHouse 26.x) into a LOGICAL_ERROR.
 */
const containsText = (value: CH.Expr<string>, search: string) =>
	CH.compileTypedFnCall("positionCaseInsensitiveUTF8", T.uint64.schema, value, CH.lit(search)).gt(0)

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
export const readsServiceSources = (scope: UsersScope): boolean =>
	scope.namespaces.length === 0 || scope.services.length > 0

const serviceScope = (service: CH.Expr<string>, scope: UsersScope) =>
	scope.namespaces.length === 0 ? undefined : CH.inList(service, scope.services)

const readsActivityRollup = (scope: UsersScope): boolean => scope.activityRollup === true

/** Whether any source can hold a user under this scope; when not, every users query is empty. */
export const hasUserSources = (scope: UsersScope): boolean =>
	readsServiceSources(scope) || scope.mcpServices.length > 0 || readsActivityRollup(scope)

const replayWindow = ($: ColumnAccessor<typeof SessionReplays.columns>) => [
	$.OrgId.eq(orgIdParam),
	$.StartTime.gte(param.dateTime("startTime")),
	$.StartTime.lte(param.dateTime("endTime")),
]

/** How far before the window a session may have started and still carry in-window events. */
const SESSION_LOOKBACK_DAYS = 1

/**
 * Sessions recorded by an in-scope service that were active in the window, including ones that
 * began up to a day before it, so their in-window browser events keep a service.
 */
const scopedSessionIds = (scope: UsersScope) =>
	from(SessionReplays)
		.select(($) => ({ sessionId: $.SessionId }))
		.where(($) => {
			const start = param.dateTime("startTime")
			return [
				$.OrgId.eq(orgIdParam),
				$.StartTime.gte(
					CH.compileTypedFnCall(
						"subtractDays",
						CH.schemaOf(start),
						start,
						CH.lit(SESSION_LOOKBACK_DAYS),
					),
				),
				$.StartTime.lte(param.dateTime("endTime")),
				CH.ifNull($.LastActivityAt, $.StartTime).gte(start),
				CH.inList($.ServiceName, scope.services),
			]
		})
		.groupBy("sessionId")

/**
 * A product event in scope: its own service, or for a browser event (no service) its session's.
 * Unscoped, every event is.
 */
const eventScope = ($: ColumnAccessor<typeof ProductEvents.columns>, scope: UsersScope) =>
	scope.namespaces.length === 0
		? undefined
		: CH.or(
				CH.inList($.ServiceName, scope.services),
				CH.and($.ServiceName.eq(""), inSubquery($.SessionId, scopedSessionIds(scope))),
			)

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

/** Rows in a selected group, per source: a user can carry several groups, and `groupId` keeps one. */
const groupHits = (groupId: CH.Expr<string>, groups: ReadonlyArray<string>) =>
	groups.length === 0 ? zero() : CH.toUInt64(CH.countIf(CH.inList(groupId, groups)))

const replayUsers = (scope: UsersScope, groups: ReadonlyArray<string>) =>
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
			spans: zero(),
			logLines: zero(),
			groupHits: groupHits($.groupId, groups),
		}))
		.where(($) => [$.userId.neq("")])
		.groupBy("userId", "namespace")

const eventUsers = (scope: UsersScope, groups: ReadonlyArray<string>) =>
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
			spans: zero(),
			logLines: zero(),
			groupHits: groupHits($.GroupId, groups),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.UserId.neq(""),
			eventScope($, scope),
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
			spans: zero(),
			logLines: zero(),
			groupHits: zero(),
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

/**
 * The name and email MCP server spans carry for the listed users: the rollup keeps neither, so the
 * directory reads them for the page's unnamed users only.
 */
export function usersMcpNamesQuery(
	mcpServices: ReadonlyArray<string>,
	userIds: ReadonlyArray<string>,
	namespaces: ReadonlyArray<string> = [],
) {
	return from(Traces)
		.select(($) => ({
			userId: mcpUserId($),
			name: nonEmpty($.SpanAttributes.get("user.name")),
			email: nonEmpty($.SpanAttributes.get("user.email")),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.SpanKind.eq("Server"),
			mcpServices.length > 0 ? CH.inList($.ServiceName, mcpServices) : CH.rawCond("1 = 0"),
			mcpMethod($).neq(""),
			userIds.length > 0 ? CH.inList(mcpUserId($), userIds) : CH.rawCond("1 = 0"),
			namespaces.length > 0
				? CH.inList($.ResourceAttributes.get("service.namespace"), namespaces)
				: undefined,
		])
		.groupBy("userId")
		.limit(Math.max(1, userIds.length))
		.format("JSON")
}

/**
 * Spans and logs with `user.id` from the rollup: entry-point requests, failed ones as errors, and
 * spans on an MCP server as MCP activity (MCP spans carry the same user id).
 */
const activityUsers = (scope: UsersScope) =>
	from(UserActivityHourly)
		.select(($) => ({
			userId: $.UserId,
			name: CH.lit(""),
			email: CH.lit(""),
			groupId: CH.lit(""),
			namespace: $.ServiceNamespace,
			// The other sources' times are DateTime64(9); UNION ALL needs one type.
			firstSeen: CH.compileTypedFnCall(
				"toDateTime64",
				T.dateTime64.schema,
				CH.min_($.FirstSeen),
				CH.lit(9),
			),
			lastSeen: CH.compileTypedFnCall(
				"toDateTime64",
				T.dateTime64.schema,
				CH.max_($.LastSeen),
				CH.lit(9),
			),
			sessions: zero(),
			errors: CH.toUInt64(CH.sum($.FailedRequestCount)),
			requests: CH.toUInt64(CH.sum($.RequestCount)),
			mcpSpans:
				scope.mcpServices.length === 0
					? zero()
					: CH.toUInt64(CH.sumIf($.SpanCount, CH.inList($.ServiceName, scope.mcpServices))),
			events: zero(),
			spans: CH.toUInt64(CH.sum($.SpanCount)),
			logLines: CH.toUInt64(CH.sum($.LogCount)),
			groupHits: zero(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			scope.namespaces.length === 0 ? undefined : CH.inList($.ServiceNamespace, scope.namespaces),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcHourFloor("endTime")),
			$.UserId.neq(""),
		])
		.groupBy("userId", "namespace")

/**
 * Every source's rows per (user, namespace). The rollup replaces the raw MCP span scan: both carry
 * the same users, and a query reading a rollup and raw spans must tile the window, which these do
 * not. Callers check {@link hasUserSources} first.
 */
const userSignals = (scope: UsersScope, groups: ReadonlyArray<string> = []) => {
	const spanSource = readsActivityRollup(scope)
		? [activityUsers(scope)]
		: scope.mcpServices.length > 0
			? [mcpUsers(scope)]
			: []
	const [first, ...rest] = [
		...(readsServiceSources(scope) ? [replayUsers(scope, groups), eventUsers(scope, groups)] : []),
		...spanSource,
	]
	return fromUnion(unionAll(first ?? replayUsers(scope, groups), ...rest), "signals")
}

/** The directory: one row per user under the filter, the most recently seen first, then by id. */
export function usersListQuery(scope: UsersScope, filter: UsersListFilter = {}, limit = 200, offset = 0) {
	return userSignals(scope, filter.groups ?? [])
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
			spans: CH.sum($.spans),
			logLines: CH.sum($.logLines),
		}))
		.groupBy("userId")
		.having(($) => [
			CH.when(filter.hasErrors === true ? true : undefined, () => CH.sum($.errors).gt(0)),
			CH.when(filter.hasReplay === true ? true : undefined, () => CH.sum($.sessions).gt(0)),
			// Any of the user's groups, counted in each source before it keeps one `groupId`.
			filter.groups !== undefined && filter.groups.length > 0 ? CH.sum($.groupHits).gt(0) : undefined,
			CH.when(filter.search, (search) =>
				CH.or(
					containsText($.userId, search),
					containsText(nonEmpty($.name), search),
					containsText(nonEmpty($.email), search),
				),
			),
		])
		.orderBy(["lastSeen", "desc"], ["userId", "asc"])
		.limit(limit)
		.offset(offset)
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
			eventScope($, scope),
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

// One user (`/users/$userId`): every read filters the exact `userId` param and the same scope as the
// directory, so the page never shows a row from a service outside the namespace in effect.

const userIdParam = param.string("userId")

/** The user's replay sessions, one row each, every field at its latest version. */
const userReplaySessions = (scope: UsersScope) =>
	from(SessionReplays)
		.select(($) => ({
			sessionId: $.SessionId,
			userName: CH.argMax($.UserName, $.Version),
			userEmail: CH.argMax($.UserEmail, $.Version),
			groupId: CH.argMax($.GroupId, $.Version),
			traitKeys: CH.argMax(CH.mapKeys($.UserTraits), $.Version),
			traitValues: CH.argMax(CH.mapValues($.UserTraits), $.Version),
			browser: CH.argMax($.BrowserName, $.Version),
			os: CH.argMax($.OsName, $.Version),
			country: CH.argMax($.Country, $.Version),
			durationMs: CH.ifNull(CH.argMax($.DurationMs, $.Version), CH.lit(0)),
			errors: CH.max_($.ErrorCount),
			startTime: CH.min_($.StartTime),
			lastActivity: CH.max_(CH.ifNull($.LastActivityAt, $.StartTime)),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.StartTime.gte(param.dateTime("startTime")),
			$.StartTime.lte(param.dateTime("endTime")),
			$.UserId.eq(userIdParam),
			serviceScope($.ServiceName, scope),
		])
		.groupBy("sessionId")

/** The user's identity and replay totals: the latest name, email, group and traits. */
export function userReplayProfileQuery(scope: UsersScope) {
	return fromQuery(userReplaySessions(scope), "sessions")
		.select(($) => ({
			name: CH.argMax($.userName, $.lastActivity),
			email: CH.argMax($.userEmail, $.lastActivity),
			groupId: CH.argMax($.groupId, $.lastActivity),
			traitKeys: CH.argMax($.traitKeys, $.lastActivity),
			traitValues: CH.argMax($.traitValues, $.lastActivity),
			country: nonEmpty($.country),
			sessions: CH.count(),
			recordedMs: CH.toUInt64(CH.sum($.durationMs)),
			errors: CH.toUInt64(CH.sum($.errors)),
			firstSeen: CH.min_($.startTime),
			lastSeen: CH.max_($.lastActivity),
		}))
		.format("JSON")
}

/** The browsers and systems the user's sessions ran on, the most used first. */
export function userDevicesQuery(scope: UsersScope) {
	return fromQuery(userReplaySessions(scope), "sessions")
		.select(($) => ({ browser: $.browser, os: $.os, sessions: CH.count() }))
		.where(($) => [$.browser.neq("").or($.os.neq(""))])
		.groupBy("browser", "os")
		.orderBy(["sessions", "desc"])
		.limit(10)
		.format("JSON")
}

const userEventRows = ($: ColumnAccessor<typeof ProductEvents.columns>, scope: UsersScope) => [
	$.OrgId.eq(orgIdParam),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
	$.UserId.eq(userIdParam),
	eventScope($, scope),
]

/**
 * The service each of the user's browser sessions was recorded by, for their events: the browser
 * SDK puts its `serviceName` on the replay, not on the event.
 */
const userSessionServices = () =>
	from(SessionReplays)
		.select(($) => ({ sessionId: $.SessionId, service: CH.any_($.ServiceName) }))
		.where(($) => [
			...replayWindow($),
			$.ServiceName.neq(""),
			inSubquery(
				$.SessionId,
				from(ProductEvents)
					.select(($e) => ({ sessionId: $e.SessionId }))
					.where(($e) => [
						$e.OrgId.eq(orgIdParam),
						$e.Timestamp.gte(param.dateTime("startTime")),
						$e.Timestamp.lte(param.dateTime("endTime")),
						$e.UserId.eq(userIdParam),
						$e.ServiceName.eq(""),
						$e.SessionId.neq(""),
					])
					.groupBy("sessionId"),
			),
		])
		.groupBy("sessionId")

/** The user's events with their service: their own, else their session's (`''` when neither). */
const userAttributedEvents = (scope: UsersScope) =>
	from(ProductEvents)
		.leftJoinQuery(userSessionServices(), "session", (e, session) => e.SessionId.eq(session.sessionId))
		.select(($) => ({
			timestamp: $.Timestamp,
			name: $.EventName,
			source: $.Source,
			service: CH.if_($.ServiceName.neq(""), $.ServiceName, CH.ifNull($.session.service, CH.lit(""))),
			pagePath: $.PagePath,
			propertyKeys: CH.mapKeys($.Attributes),
			propertyValues: CH.mapValues($.Attributes),
		}))
		.where(($) => userEventRows($, scope))

/** The user's product event totals: how many, how many distinct names, and when. */
export function userEventsSummaryQuery(scope: UsersScope) {
	return from(ProductEvents)
		.select(($) => ({
			events: CH.count(),
			distinctEvents: CH.uniqExact($.EventName),
			firstSeen: CH.min_($.Timestamp),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => userEventRows($, scope))
		.format("JSON")
}

/** The user's product events, the latest first, with their page, properties and service. */
export function userEventsQuery(scope: UsersScope, limit = 200) {
	return fromQuery(userAttributedEvents(scope), "events")
		.select(($) => ({
			timestamp: $.timestamp,
			name: $.name,
			source: $.source,
			service: $.service,
			pagePath: $.pagePath,
			propertyKeys: $.propertyKeys,
			propertyValues: $.propertyValues,
		}))
		.orderBy(["timestamp", "desc"])
		.limit(limit)
		.format("JSON")
}

const userMcpSpans = ($: ColumnAccessor<typeof Traces.columns>, scope: UsersScope) => [
	$.OrgId.eq(orgIdParam),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
	$.SpanKind.eq("Server"),
	CH.inList($.ServiceName, scope.mcpServices),
	mcpMethod($).neq(""),
	mcpUserId($).eq(userIdParam),
	scope.namespaces.length === 0
		? undefined
		: CH.inList($.ResourceAttributes.get("service.namespace"), scope.namespaces),
]

/** The user's MCP requests over every MCP server. Callers skip it when no service answers MCP. */
export function userMcpSummaryQuery(scope: UsersScope) {
	return from(Traces)
		.select(($) => ({
			name: nonEmpty($.SpanAttributes.get("user.name")),
			email: nonEmpty($.SpanAttributes.get("user.email")),
			requests: CH.count(),
			calls: CH.countIf(mcpMethod($).eq("tools/call")),
			firstSeen: CH.min_($.Timestamp),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => userMcpSpans($, scope))
		.format("JSON")
}

/** The services the user's signals came from, with each one's namespace and signal count. */
export function userServicesQuery(scope: UsersScope) {
	const replays = fromQuery(
		from(SessionReplays)
			.select(($) => ({ sessionId: $.SessionId, service: CH.any_($.ServiceName) }))
			.where(($) => [
				$.OrgId.eq(orgIdParam),
				$.StartTime.gte(param.dateTime("startTime")),
				$.StartTime.lte(param.dateTime("endTime")),
				$.UserId.eq(userIdParam),
				serviceScope($.ServiceName, scope),
			])
			.groupBy("sessionId"),
		"sessions",
	)
		.select(($) => ({
			service: $.service,
			namespace: namespaceOf($.service, scope),
			signals: CH.count(),
		}))
		.groupBy("service", "namespace")
	const events = fromQuery(userAttributedEvents(scope), "events")
		.select(($) => ({
			service: $.service,
			namespace: namespaceOf($.service, scope),
			signals: CH.count(),
		}))
		.where(($) => [$.service.neq("")])
		.groupBy("service", "namespace")
	const mcp = from(Traces)
		.select(($) => ({
			service: $.ServiceName,
			namespace: $.ResourceAttributes.get("service.namespace"),
			signals: CH.count(),
		}))
		.where(($) => userMcpSpans($, scope))
		.groupBy("service", "namespace")
	const [first, ...rest] = [
		...(readsServiceSources(scope) ? [replays, events] : []),
		...(scope.mcpServices.length > 0 ? [mcp] : []),
	]
	return fromUnion(unionAll(first ?? replays, ...rest), "signals")
		.select(($) => ({ service: $.service, namespace: $.namespace, signals: CH.sum($.signals) }))
		.where(($) => [$.service.neq("")])
		.groupBy("service", "namespace")
		.orderBy(["signals", "desc"])
		.limit(50)
		.format("JSON")
}

/** The visitor ids the user signed in from, the first linked first. */
export function userVisitorIdsQuery(limit = 50) {
	return from(IdentityLinks)
		.select(($) => ({ visitorId: $.VisitorId, firstSeen: CH.min_($.FirstSeen) }))
		.where(($) => [$.OrgId.eq(orgIdParam), $.UserId.eq(userIdParam)])
		.groupBy("visitorId")
		.orderBy(["firstSeen", "asc"])
		.limit(limit)
		.format("JSON")
}
