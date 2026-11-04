import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	SessionId,
	UserDetailRequest,
	UsersListRequest,
	type UserActivityItem,
	type UserIssueItem,
	type UserListItem,
	type UserMcpSessionItem,
	type UserProfileItem,
	type UserSessionItem,
} from "@maple/domain/http"
import {
	isoTimestamp,
	MapleApiV2,
	paginateArray,
	paginateOffsetQuery,
	V2ParameterInvalid,
	V2TelemetryRangeTooLarge,
	V2TimeRangeInvalid,
	V2UserNotFound,
	type V2User,
	type V2UserActivity,
	type V2UserIssue,
	type V2UserProfile,
} from "@maple/domain/http/v2"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { formatRangeSeconds, MAX_QUERY_RANGE_SECONDS, timeWindowViolation } from "@maple/query-engine/runtime"
import { Array as Arr, Effect, Record as Rec, Schema, String as Str } from "effect"
import { UsersReadService } from "@maple/backend/services/users/UsersReadService"

// `/v2/users`: thin adapters over `UsersReadService`, mapping its camelCase epoch-ms rows to the
// snake_case ISO wire shape. Windows are capped like the other telemetry reads.

const decodeSessionId = Schema.decodeSync(SessionId)

/** The internal request, or a 400: its caps (50 namespaces or groups, the deepest offset) are tighter than the query's. */
const internalRequest =
	<S extends Schema.Codec<unknown, unknown, never, never>>(schema: S) =>
	(input: unknown) =>
		Schema.decodeUnknownEffect(schema)(input).pipe(
			Effect.mapError(() => V2ParameterInvalid.make("A filter or the cursor is out of range.")),
		)
const listRequest = internalRequest(UsersListRequest)
const userRequest = internalRequest(UserDetailRequest)

type WindowQuery = Readonly<{ start_time: string; end_time: string; namespace?: string | undefined }>

/** A comma-separated query value as its trimmed, non-empty entries. */
export const commaList = (value: string | undefined): ReadonlyArray<string> =>
	value === undefined
		? []
		: Arr.filter(
				Arr.map(Str.split(value, ","), (entry) => Str.trim(entry)),
				Str.isNonEmpty,
			)

/** The request's window and namespaces as the users reads take them. */
export const resolveUsersWindow = (query: WindowQuery) =>
	Effect.gen(function* () {
		const startMs = parseWarehouseDateTime(query.start_time)
		const endMs = parseWarehouseDateTime(query.end_time)
		const violation = timeWindowViolation(startMs, endMs, MAX_QUERY_RANGE_SECONDS)
		if (violation === "empty") {
			return yield* V2TimeRangeInvalid.make("end_time must be later than start_time.", {
				param: "end_time",
			})
		}
		if (violation === "too_wide") {
			return yield* V2TelemetryRangeTooLarge.make(
				`User reads support a maximum time range of ${formatRangeSeconds(MAX_QUERY_RANGE_SECONDS)}.`,
				{ param: "start_time" },
			)
		}
		const namespaces = commaList(query.namespace)
		return {
			startTime: formatWarehouseDateTime(startMs),
			endTime: formatWarehouseDateTime(endMs),
			...(namespaces.length > 0 && { namespaces }),
		}
	})

const isoOf = (epochMs: number) => isoTimestamp(epochMs)

export const toV2User = (user: UserListItem): V2User => ({
	id: user.userId,
	object: "user",
	name: user.name,
	email: user.email,
	group_id: user.groupId,
	first_seen_at: isoOf(user.firstSeenMs),
	last_seen_at: isoOf(user.lastSeenMs),
	session_count: user.sessions,
	top_route: user.topRoute,
	activity: user.activity,
	signals: user.signals,
	namespaces: user.namespaces,
	error_count: user.errors,
	request_count: user.requests,
})

export const toV2UserProfile = (profile: UserProfileItem): V2UserProfile => ({
	id: profile.userId,
	object: "user",
	name: profile.name,
	email: profile.email,
	group_id: profile.groupId,
	first_seen_at: isoOf(profile.firstSeenMs),
	last_seen_at: isoOf(profile.lastSeenMs),
	session_count: profile.sessions,
	top_route: profile.topRoute,
	activity: profile.activity,
	signals: profile.signals,
	traits: Rec.fromEntries(Arr.map(profile.traits, (trait) => [trait.key, trait.value] as const)),
	visitor_ids: profile.visitorIds,
	recorded_ms: profile.recordedMs,
	replay_error_count: profile.replayErrors,
	event_count: profile.events,
	distinct_event_count: profile.distinctEvents,
	mcp_request_count: profile.mcpRequests,
	mcp_call_count: profile.mcpCalls,
	devices: Arr.map(profile.devices, (device) => ({
		browser: device.browser,
		os: device.os,
		session_count: device.sessions,
	})),
	country: profile.country,
	services: Arr.map(profile.services, (service) => ({
		service_name: service.service,
		namespace: service.namespace === "" ? null : service.namespace,
		signal_count: service.signals,
	})),
	request_count: profile.requests,
	failed_request_rate: profile.failedRate,
	p95_duration_ms: profile.p95Ms,
	trace_count: profile.traces,
	log_count: profile.logs,
	issue_count: profile.issues,
	issue_hit_count: profile.issueHits,
})

const toV2Session = (session: UserSessionItem) => ({
	id: decodeSessionId(session.sessionId),
	service_name: session.service,
	start_time: isoOf(session.startedMs),
	duration_ms: session.durationMs,
	page_views: session.pages,
	error_count: session.errors,
	entry_path: session.entryPath,
	device: session.device,
})

const toV2McpSession = (session: UserMcpSessionItem) => ({
	service_name: session.service,
	session_id: session.sessionId,
	source: session.source,
	client: session.client,
	client_kind: session.kind,
	request_count: session.requests,
	call_count: session.calls,
	error_count: session.errors,
	tool_count: session.tools,
	first_seen_at: isoOf(session.firstSeenMs),
	last_seen_at: isoOf(session.lastSeenMs),
})

const toV2ActivityEntry = (entry: UserActivityItem) => ({
	kind: entry.kind,
	timestamp: isoOf(entry.atMs),
	service_name: entry.service,
	title: entry.title,
	detail: entry.detail,
	tone: entry.tone,
	session_replay_id:
		entry.kind === "session" && entry.sessionId !== null ? decodeSessionId(entry.sessionId) : null,
	mcp_session_id: entry.kind === "mcp" ? entry.sessionId : null,
	trace_id: entry.traceId,
	issue_id: entry.issueId,
})

export const toV2UserIssue = (issue: UserIssueItem): V2UserIssue => ({
	object: "user.issue",
	issue_id: issue.issueId,
	fingerprint_hash: issue.fingerprintHash,
	type: issue.type,
	message: issue.message,
	service_name: issue.service,
	hit_count: issue.hits,
	first_seen_at: isoOf(issue.firstSeenMs),
	last_seen_at: isoOf(issue.lastSeenMs),
	workflow_state: issue.status,
})

const detailRequest = (userId: string, query: WindowQuery) =>
	Effect.flatMap(resolveUsersWindow(query), (window) => userRequest({ ...window, userId }))

export const HttpV2UsersLive = HttpApiBuilder.group(MapleApiV2, "users", (handlers) =>
	Effect.gen(function* () {
		const users = yield* UsersReadService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* resolveUsersWindow(query)
					const groups = commaList(query.group)
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						listRequest({
							...window,
							limit,
							offset,
							...(query.q !== undefined && { search: query.q }),
							...(query.has_errors === "true" && { hasErrors: true }),
							...(groups.length > 0 && { groups }),
						}).pipe(
							Effect.flatMap((request) => users.list(tenant, request)),
							Effect.map((response) => Arr.map(response.users, toV2User)),
						),
					)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const request = yield* detailRequest(params.user_id, query)
					const { profile } = yield* users.profile(tenant, request)
					if (profile === null) return yield* V2UserNotFound.make()
					return toV2UserProfile(profile)
				}),
			)
			.handle("activity", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const request = yield* detailRequest(params.user_id, query)
					const activity = yield* users.activity(tenant, request)
					const result: V2UserActivity = {
						object: "user.activity",
						user_id: params.user_id,
						sessions: Arr.map(activity.sessions, toV2Session),
						events: Arr.map(activity.events, (event) => ({
							timestamp: isoOf(event.atMs),
							name: event.name,
							source: event.source,
							service_name: event.service,
							detail: event.detail,
						})),
						mcp_sessions: Arr.map(activity.mcpSessions, toV2McpSession),
						timeline: Arr.map(activity.activity, toV2ActivityEntry),
					}
					return result
				}),
			)
			.handle("issues", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const request = yield* detailRequest(params.user_id, query)
					const { issues, attributed } = yield* users.issues(tenant, request)
					const page = yield* paginateArray(Arr.map(issues, toV2UserIssue), query)
					return { object: "list" as const, ...page, attributed }
				}),
			)
	}),
)
