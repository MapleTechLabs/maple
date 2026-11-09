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
	exactDateTime64,
	IdentityLinks,
	ProductEvents,
	SessionReplays,
	Traces,
	UserActivityHourly,
	orgIdParam,
} from "../tables"
import {
	method as mcpMethod,
	userId as mcpUserId,
	userIdIn as mcpUserIdIn,
	userIdIs as mcpUserIdIs,
} from "./mcp"
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
	/** Read the rollup's request channel counts (migration 0058); only the directory list asks. */
	readonly requestChannels?: boolean
}

/** The directory's filters, applied per user after every source is merged. */
export interface UsersListFilter {
	/** Case-insensitive substring of the user id, name or email. */
	readonly search?: string
	/** Users the search matched outside this query: MCP users whose name the rollup does not keep. */
	readonly searchUserIds?: ReadonlyArray<string>
	readonly hasErrors?: boolean
	readonly hasReplay?: boolean
	readonly groups?: ReadonlyArray<string>
	/**
	 * Keyset: only users ordered after this `(lastSeen, userId)`. `lastSeen` is a row's exact
	 * `lastSeenKey` (`toString` of the DateTime64(9)), so the tie branch matches it.
	 */
	readonly after?: { readonly lastSeen: string; readonly userId: string }
}

/**
 * Case-insensitive substring match. Not `ILIKE`: an `OR` of LIKEs over aggregates in HAVING trips
 * `optimize_or_like_chain` (on by default since ClickHouse 26.x) into a LOGICAL_ERROR.
 */
const containsText = (value: CH.Expr<string>, search: string) =>
	CH.compileTypedFnCall("positionCaseInsensitiveUTF8", T.uint64.schema, value, CH.lit(search)).gt(0)

/** Any non-empty value in the group, `''` when none. */
const nonEmpty = (value: CH.Expr<string>) => CH.anyIf(value, value.neq(""))

/**
 * The value from the latest row that has one, `''` when none: empty values rank at the epoch. The
 * list and the profile then agree on a user who changed name, email or group.
 */
const latestNonEmpty = <A>(value: CH.Expr<string>, at: CH.Expr<A>) => latestPaired(value, value, at)

/** `value` from the latest row whose `key` is non-empty: a group's name from the session its id came from. */
const latestPaired = <A>(value: CH.Expr<string>, key: CH.Expr<string>, at: CH.Expr<A>) =>
	CH.argMax(value, CH.if_(key.neq(""), epochSeconds(at), CH.lit(0)))

const epochSeconds = <A>(at: CH.Expr<A>) => CH.compileTypedFnCall("toFloat64", T.float64.schema, at)

/**
 * When a source last carried a non-empty `value` (epoch seconds, 0 for never), so the merge across
 * sources picks the newest value itself, not the newest source.
 */
const seenAt = <A>(value: CH.Expr<string>, at: CH.Expr<A>) =>
	CH.compileTypedFnCall("toFloat64", T.float64.schema, CH.maxIf(epochSeconds(at), value.neq("")))

const neverSeen = () => CH.compileTypedFnCall("toFloat64", T.float64.schema, CH.lit(0))

const zero = () => CH.toUInt64(CH.lit(0))

/** A service's namespace from the caller's map, `fallback` (default `''`) for a service it does not know. */
const namespaceOf = (
	service: CH.Expr<string>,
	scope: UsersScope,
	fallback: CH.Expr<string> = CH.lit(""),
): CH.Expr<string> =>
	scope.serviceNamespaces.length === 0
		? fallback
		: CH.compileTypedFnCall(
				"transform",
				T.string.schema,
				service,
				CH.arrayOf(...Arr.map(scope.serviceNamespaces, ([service]) => CH.lit(service))),
				CH.arrayOf(...Arr.map(scope.serviceNamespaces, ([, namespace]) => CH.lit(namespace))),
				fallback,
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

/** How far before the window a session may have started and still carry in-window events. */
const SESSION_LOOKBACK_DAYS = 1

/** Sessions active in the window, including ones that began up to a day before it. */
const activeSessionWindow = ($: ColumnAccessor<typeof SessionReplays.columns>) => {
	const start = param.dateTime("startTime")
	return [
		$.OrgId.eq(orgIdParam),
		$.StartTime.gte(
			CH.compileTypedFnCall("subtractDays", CH.schemaOf(start), start, CH.lit(SESSION_LOOKBACK_DAYS)),
		),
		$.StartTime.lte(param.dateTime("endTime")),
		CH.ifNull($.LastActivityAt, $.StartTime).gte(start),
	]
}

/** Sessions recorded by an in-scope service and active in the window, so their in-window browser events keep a service. */
const scopedSessionIds = (scope: UsersScope) =>
	from(SessionReplays)
		.select(($) => ({ sessionId: $.SessionId }))
		.where(($) => [...activeSessionWindow($), CH.inList($.ServiceName, scope.services)])
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

/** Groups one user counts toward at most, per source. */
const USER_GROUPS_MAX = 20

/** Every group a source saw the user in; `groupId` keeps only one of them, for display. */
const sourceGroups = (groupId: CH.Expr<string>) =>
	CH.groupUniqArrayIf(USER_GROUPS_MAX)(groupId, groupId.neq(""))

/** A source with no group column. Typed, so UNION ALL matches the other branches' `Array(String)`. */
const noGroups = () => CH.rawExpr<ReadonlyArray<string>>("CAST([], 'Array(String)')", T.array(T.string))

/** A user's groups across every source row, each once. */
const mergedGroups = (groupIds: CH.Expr<ReadonlyArray<string>>) =>
	CH.compileTypedFnCall(
		"arrayDistinct",
		T.array(T.string).schema,
		CH.compileTypedFnCall("groupArrayArray", T.array(T.string).schema, groupIds),
	)

const replayUsers = (scope: UsersScope) =>
	fromQuery(replaySessions(scope), "sessions")
		.select(($) => ({
			userId: $.userId,
			name: latestNonEmpty($.userName, $.lastActivity),
			email: latestNonEmpty($.userEmail, $.lastActivity),
			groupId: latestNonEmpty($.groupId, $.lastActivity),
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
			...noChannels(),
			groupIds: sourceGroups($.groupId),
			nameAt: seenAt($.userName, $.lastActivity),
			emailAt: seenAt($.userEmail, $.lastActivity),
			groupAt: seenAt($.groupId, $.lastActivity),
		}))
		.where(($) => [$.userId.neq("")])
		.groupBy("userId", "namespace")

const eventUsers = (scope: UsersScope) =>
	from(ProductEvents)
		.select(($) => ({
			userId: $.UserId,
			name: CH.lit(""),
			email: CH.lit(""),
			groupId: latestNonEmpty($.GroupId, $.Timestamp),
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
			...noChannels(),
			groupIds: sourceGroups($.GroupId),
			nameAt: neverSeen(),
			emailAt: neverSeen(),
			groupAt: seenAt($.GroupId, $.Timestamp),
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
			name: latestNonEmpty($.SpanAttributes.get("user.name"), $.Timestamp),
			email: latestNonEmpty($.SpanAttributes.get("user.email"), $.Timestamp),
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
			// Every request here is an MCP tool call, counted as `requests` counts them.
			classifiedRequests: CH.toUInt64(CH.countIf(mcpMethod($).eq("tools/call"))),
			mcpRequests: CH.toUInt64(CH.countIf(mcpMethod($).eq("tools/call"))),
			webRequests: zero(),
			mobileRequests: zero(),
			groupIds: noGroups(),
			nameAt: seenAt($.SpanAttributes.get("user.name"), $.Timestamp),
			emailAt: seenAt($.SpanAttributes.get("user.email"), $.Timestamp),
			groupAt: neverSeen(),
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
			userIds.length > 0 ? mcpUserIdIn($, userIds) : CH.rawCond("1 = 0"),
			// A span without either key adds no name, and the `mapKeys` bloom index skips its granule.
			CH.mapContains($.SpanAttributes, "user.name").or(CH.mapContains($.SpanAttributes, "user.email")),
			namespaces.length > 0
				? CH.inList($.ResourceAttributes.get("service.namespace"), namespaces)
				: undefined,
		])
		.groupBy("userId")
		.limit(Math.max(1, userIds.length))
		.format("JSON")
}

/**
 * Each group's latest name from `identify({ groupName })`. Only replays carry it, so a group seen
 * only in product events or spans has no row and the caller shows its id.
 */
export function usersGroupNamesQuery(groupIds: ReadonlyArray<string>, scope?: UsersScope) {
	return from(SessionReplays)
		.select(($) => ({
			groupId: $.GroupId,
			// A replay's start and end rows share a StartTime: the later version breaks the tie.
			groupName: CH.argMax(
				$.GroupName,
				CH.compileTypedFnCall("tuple", T.string.schema, $.StartTime, $.Version),
			),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.StartTime.gte(param.dateTime("startTime")),
			$.StartTime.lte(param.dateTime("endTime")),
			groupIds.length > 0 ? CH.inList($.GroupId, groupIds) : CH.rawCond("1 = 0"),
			$.GroupName.neq(""),
			scope === undefined ? undefined : serviceScope($.ServiceName, scope),
		])
		.groupBy("groupId")
		.limit(Math.max(1, groupIds.length))
		.format("JSON")
}

/** Max MCP users a name search hands to the directory's search. */
const MCP_NAME_SEARCH_LIMIT = 500

/**
 * MCP users whose span `user.name` or `user.email` contains `search`: the rollup keeps no name, so
 * the directory's search also accepts these ids.
 */
export function usersMcpNameSearchQuery(
	mcpServices: ReadonlyArray<string>,
	search: string,
	namespaces: ReadonlyArray<string> = [],
) {
	return (
		from(Traces)
			.select(($) => ({ userId: mcpUserId($) }))
			.where(($) => [
				$.OrgId.eq(orgIdParam),
				$.Timestamp.gte(param.dateTime("startTime")),
				$.Timestamp.lte(param.dateTime("endTime")),
				$.SpanKind.eq("Server"),
				mcpServices.length > 0 ? CH.inList($.ServiceName, mcpServices) : CH.rawCond("1 = 0"),
				mcpMethod($).neq(""),
				mcpUserId($).neq(""),
				CH.mapContains($.SpanAttributes, "user.name").or(
					CH.mapContains($.SpanAttributes, "user.email"),
				),
				CH.or(
					containsText($.SpanAttributes.get("user.name"), search),
					containsText($.SpanAttributes.get("user.email"), search),
				),
				namespaces.length > 0
					? CH.inList($.ResourceAttributes.get("service.namespace"), namespaces)
					: undefined,
			])
			.groupBy("userId")
			// A stable order, so the cap keeps the same ids on every call.
			.orderBy(["userId", "asc"])
			.limit(MCP_NAME_SEARCH_LIMIT)
			.format("JSON")
	)
}

/** A source that classifies no requests: its rows add nothing to the channel shares. */
const noChannels = () => ({
	classifiedRequests: zero(),
	mcpRequests: zero(),
	webRequests: zero(),
	mobileRequests: zero(),
})

/**
 * The rollup's requests by channel. A request on an MCP server is MCP whatever its client; of the
 * rest, the rollup marks the web and mobile ones and the remainder is API. Off, no channel is read.
 */
const activityChannels = ($: ColumnAccessor<typeof UserActivityHourly.columns>, scope: UsersScope) => {
	if (scope.requestChannels !== true) return noChannels()
	const onMcp = CH.inList($.ServiceName, scope.mcpServices)
	const offMcp = (count: CH.Expr<number>) =>
		scope.mcpServices.length === 0
			? CH.toUInt64(CH.sum(count))
			: CH.toUInt64(CH.sumIf(count, CH.not(onMcp)))
	return {
		classifiedRequests: CH.toUInt64(CH.sum($.ClassifiedRequestCount)),
		mcpRequests:
			scope.mcpServices.length === 0 ? zero() : CH.toUInt64(CH.sumIf($.ClassifiedRequestCount, onMcp)),
		webRequests: offMcp($.WebRequestCount),
		mobileRequests: offMcp($.MobileRequestCount),
	}
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
			...activityChannels($, scope),
			groupIds: noGroups(),
			nameAt: neverSeen(),
			emailAt: neverSeen(),
			groupAt: neverSeen(),
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
const userSignals = (scope: UsersScope) => {
	const spanSource = readsActivityRollup(scope)
		? [activityUsers(scope)]
		: scope.mcpServices.length > 0
			? [mcpUsers(scope)]
			: []
	const [first, ...rest] = [
		...(readsServiceSources(scope) ? [replayUsers(scope), eventUsers(scope)] : []),
		...spanSource,
	]
	return fromUnion(unionAll(first ?? replayUsers(scope), ...rest), "signals")
}

/** One row per user under the filter, every source merged: the directory and its group view read it. */
const usersPerUser = (scope: UsersScope, filter: UsersListFilter) =>
	userSignals(scope)
		.select(($) => ({
			userId: $.userId,
			name: CH.argMax($.name, $.nameAt),
			email: CH.argMax($.email, $.emailAt),
			groupId: CH.argMax($.groupId, $.groupAt),
			/** Every group any source saw the user in; `groupId` keeps the newest. */
			groupIds: CH.arraySort(mergedGroups($.groupIds)),
			namespaces: CH.arraySort(CH.groupUniqArrayIf(20)($.namespace, $.namespace.neq(""))),
			firstSeen: CH.min_($.firstSeen),
			lastSeen: CH.max_($.lastSeen),
			// Lossless, unlike the decoded `lastSeen`: the keyset cursor carries it back verbatim.
			lastSeenKey: CH.toString_(CH.max_($.lastSeen)),
			sessions: CH.sum($.sessions),
			errors: CH.sum($.errors),
			requests: CH.sum($.requests),
			mcpSpans: CH.sum($.mcpSpans),
			events: CH.sum($.events),
			spans: CH.sum($.spans),
			logLines: CH.sum($.logLines),
			classifiedRequests: CH.sum($.classifiedRequests),
			mcpRequests: CH.sum($.mcpRequests),
			webRequests: CH.sum($.webRequests),
			mobileRequests: CH.sum($.mobileRequests),
		}))
		.groupBy("userId")
		.having(($) => [
			CH.when(filter.hasErrors === true ? true : undefined, () => CH.sum($.errors).gt(0)),
			CH.when(filter.hasReplay === true ? true : undefined, () => CH.sum($.sessions).gt(0)),
			// Any of the user's groups, not only the one `groupId` keeps.
			filter.groups !== undefined && filter.groups.length > 0
				? CH.compileTypedFnCall(
						"hasAny",
						T.uint8.schema,
						mergedGroups($.groupIds),
						CH.arrayOf(...Arr.map(filter.groups, (group) => CH.lit(group))),
					).eq(1)
				: undefined,
			CH.when(filter.search, (search) =>
				CH.or(
					containsText($.userId, search),
					containsText(CH.argMax($.name, $.nameAt), search),
					containsText(CH.argMax($.email, $.emailAt), search),
					...(filter.searchUserIds !== undefined && filter.searchUserIds.length > 0
						? [CH.inList($.userId, filter.searchUserIds)]
						: []),
				),
			),
			CH.when(filter.after, (after) => {
				const at = exactDateTime64(after.lastSeen)
				return CH.max_($.lastSeen)
					.lt(at)
					.or(CH.max_($.lastSeen).eq(at).and($.userId.gt(after.userId)))
			}),
		])

/** The directory: one row per user under the filter, the most recently seen first, then by id. */
export function usersListQuery(scope: UsersScope, filter: UsersListFilter = {}, limit = 200) {
	return usersPerUser(scope, filter)
		.orderBy(["lastSeen", "desc"], ["userId", "asc"])
		.limit(limit)
		.format("JSON")
}

/**
 * The directory grouped: one row per group over the same filtered users, the largest first. A
 * user in two groups counts in both; users in none share the `''` row. A user's requests and
 * errors count in full toward each of their groups, though spans carry no group themselves.
 * Picked `groups` keep only those rows.
 */
export function usersGroupsQuery(scope: UsersScope, filter: UsersListFilter = {}, limit = 200) {
	const picked = filter.groups ?? []
	return fromQuery(usersPerUser(scope, filter), "per_user")
		.select(($) => {
			const groups =
				picked.length === 0
					? $.groupIds
					: CH.compileTypedFnCall(
							"arrayIntersect",
							T.array(T.string).schema,
							$.groupIds,
							CH.arrayOf(...Arr.map(picked, (group) => CH.lit(group))),
						)
			// Typed explicitly: `if_` over two arrays loses the element type, and the row then goes undecoded.
			const orUngrouped = CH.compileTypedFnCall(
				"if",
				T.array(T.string).schema,
				CH.compileTypedFnCall("empty", T.uint8.schema, groups),
				CH.arrayOf(CH.lit("")),
				groups,
			)
			return {
				groupId: CH.arrayJoin(orUngrouped),
				users: CH.count(),
				activeToday: CH.countIf($.lastSeen.gte(param.dateTime("activeSince"))),
				withErrors: CH.countIf($.errors.gt(0)),
				withReplay: CH.countIf($.sessions.gt(0)),
				sessions: CH.sum($.sessions),
				errors: CH.sum($.errors),
				requests: CH.sum($.requests),
				firstSeen: CH.min_($.firstSeen),
				lastSeen: CH.max_($.lastSeen),
			}
		})
		.groupBy("groupId")
		.orderBy(["users", "desc"], ["groupId", "asc"])
		.limit(limit)
		.format("JSON")
}

/**
 * Users per namespace and per group, as `(name, count, facetType)`. Without `namespaceScope` (a
 * pinned scope) the namespace facet is skipped.
 */
export function usersFacetsQuery(scope: UsersScope, namespaceScope?: UsersScope) {
	// One row per group a source saw the user in: a user in two groups counts in both.
	const groups = userSignals(scope)
		.select(($) => ({
			// Typed: the union's array column carries no element type, and an untyped column leaves the row undecoded.
			name: CH.compileTypedFnCall("arrayJoin", T.string.schema, $.groupIds),
			count: CH.uniqExact($.userId),
			facetType: CH.lit("group"),
		}))
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
			groupName: CH.argMax($.GroupName, $.Version),
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

/** The user's identity and replay totals: the latest name, email, group (id and name, one session's) and traits. */
export function userReplayProfileQuery(scope: UsersScope) {
	return fromQuery(userReplaySessions(scope), "sessions")
		.select(($) => ({
			// The latest non-empty values, as the directory reads them; the name from the group's session.
			name: latestNonEmpty($.userName, $.lastActivity),
			email: latestNonEmpty($.userEmail, $.lastActivity),
			groupId: latestNonEmpty($.groupId, $.lastActivity),
			groupName: latestPaired($.groupName, $.groupId, $.lastActivity),
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
			...activeSessionWindow($),
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
	mcpUserIdIs($, userIdParam),
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
	// The same map as the replay and event arms, so one service reaches the rail once.
	const mcp = from(Traces)
		.select(($) => ({
			service: $.ServiceName,
			namespace: namespaceOf($.ServiceName, scope, $.ResourceAttributes.get("service.namespace")),
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
