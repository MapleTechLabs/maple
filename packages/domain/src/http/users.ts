import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { McpClientKind, McpSessionSource } from "./mcp"
import { ServiceNamespace } from "../primitives"
import { TinybirdDateTime } from "../query-engine"
import { AuditedRead } from "./audit-log"
import { SessionAuthorization } from "./current-tenant"
import { warehouseReadHttpErrors } from "./warehouse"

// End users endpoint schemas (`/users`): the people Maple's customers identified with `identify()`
// or a `user.id` span attribute, read by `ch/queries/users.ts` and `user-activity.ts`. Times are
// epoch milliseconds.

const searchText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const groupId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))

const windowFields = {
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	/** The namespaces in effect: the org pin, else the rail's picks. Empty or absent is every one. */
	namespaces: Schema.optionalKey(Schema.Array(ServiceNamespace).check(Schema.isMaxLength(50))),
}

/** A signal Maple holds for a user. */
export const UserSignalKind = Schema.Literals(["replay", "events", "mcp", "traces", "logs"])
export type UserSignalKind = typeof UserSignalKind.Type

export const UserListItem = Schema.Struct({
	userId: Schema.String,
	name: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
	groupId: Schema.NullOr(Schema.String),
	namespaces: Schema.Array(Schema.String),
	firstSeenMs: Schema.Number,
	lastSeenMs: Schema.Number,
	sessions: Schema.Number,
	/** Errors the browser SDK recorded in the user's sessions, plus their failed requests. */
	errors: Schema.Number,
	/** Entry-point requests carrying the user's id; MCP tool calls where the span rollup is absent. */
	requests: Schema.Number,
	/** The user's busiest route, `null` without requests. */
	topRoute: Schema.NullOr(Schema.String),
	/** Requests in 7 equal slices of the window, oldest first; empty without the span rollup. */
	activity: Schema.Array(Schema.Number),
	signals: Schema.Array(UserSignalKind),
})
export type UserListItem = typeof UserListItem.Type

export class UsersListRequest extends Schema.Class<UsersListRequest>("UsersListRequest")({
	...windowFields,
	search: Schema.optionalKey(searchText),
	hasErrors: Schema.optionalKey(Schema.Boolean),
	hasReplay: Schema.optionalKey(Schema.Boolean),
	groups: Schema.optionalKey(Schema.Array(groupId).check(Schema.isMaxLength(50))),
	limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
}) {}

export class UsersListResponse extends Schema.Class<UsersListResponse>("UsersListResponse")({
	users: Schema.Array(UserListItem),
}) {}

const FacetOption = Schema.Struct({ name: Schema.String, count: Schema.Number })

/** `namespaces` is the org pin only: the rail's picks never change the facets. */
export class UsersFacetsRequest extends Schema.Class<UsersFacetsRequest>("UsersFacetsRequest")({
	...windowFields,
}) {}

export class UsersFacetsResponse extends Schema.Class<UsersFacetsResponse>("UsersFacetsResponse")({
	/** Users per namespace over every namespace; empty under a pin. */
	namespaces: Schema.Array(FacetOption),
	groups: Schema.Array(FacetOption),
	withErrors: Schema.Number,
	withReplay: Schema.Number,
	identified: Schema.Number,
	/** Users with any signal in the 24 hours before the request. */
	activeToday: Schema.Number,
	/** Visitors in the window that never carried a user id. */
	anonymousVisitors: Schema.Number,
}) {}

// ---------------------------------------------------------------------------
// /users/:userId
// ---------------------------------------------------------------------------

/** An end user's id as the SDK sent it: opaque, matched exactly. */
export const EndUserId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))

export class UserDetailRequest extends Schema.Class<UserDetailRequest>("UserDetailRequest")({
	...windowFields,
	userId: EndUserId,
}) {}

export const UserService = Schema.Struct({
	service: Schema.String,
	/** `''` when the service map does not know the service. */
	namespace: Schema.String,
	/** Sessions, events, requests and log lines from the service. */
	signals: Schema.Number,
})
export type UserService = typeof UserService.Type

const UserDevice = Schema.Struct({ browser: Schema.String, os: Schema.String, sessions: Schema.Number })

/**
 * A user's identity and totals. The request numbers read `user_activity_hourly`; they are `null`
 * where a cluster lacks it (never a fake zero). `issues` arrives with the per-user issues read.
 */
export const UserProfileItem = Schema.Struct({
	userId: Schema.String,
	name: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
	groupId: Schema.NullOr(Schema.String),
	/** `identify()` traits from the latest session. */
	traits: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
	/** Browser visitor ids linked to the user before sign-in. */
	visitorIds: Schema.Array(Schema.String),
	firstSeenMs: Schema.Number,
	lastSeenMs: Schema.Number,
	sessions: Schema.Number,
	recordedMs: Schema.Number,
	/** Errors the browser SDK recorded in the user's sessions. */
	replayErrors: Schema.Number,
	events: Schema.Number,
	distinctEvents: Schema.Number,
	mcpRequests: Schema.Number,
	mcpCalls: Schema.Number,
	devices: Schema.Array(UserDevice),
	/** The country of the sessions (ISO code), when the gateway knew it. */
	country: Schema.NullOr(Schema.String),
	services: Schema.Array(UserService),
	signals: Schema.Array(UserSignalKind),
	/** Entry-point requests. */
	requests: Schema.NullOr(Schema.Number),
	/** Failed requests over requests, 0 to 1; `null` without requests. */
	failedRate: Schema.NullOr(Schema.Number),
	/** p95 request latency; `null` without requests. */
	p95Ms: Schema.NullOr(Schema.Number),
	/** Distinct traces the user's spans belong to. */
	traces: Schema.NullOr(Schema.Number),
	logs: Schema.NullOr(Schema.Number),
	issues: Schema.NullOr(Schema.Number),
	/** The busiest route, `null` without requests. */
	topRoute: Schema.NullOr(Schema.String),
	/** Requests in 7 equal slices of the window, oldest first. */
	activity: Schema.Array(Schema.Number),
})
export type UserProfileItem = typeof UserProfileItem.Type

export class UserProfileResponse extends Schema.Class<UserProfileResponse>("UserProfileResponse")({
	/** `null` when no signal in the window and scope carries the user. */
	profile: Schema.NullOr(UserProfileItem),
}) {}

export const UserSessionItem = Schema.Struct({
	sessionId: Schema.String,
	service: Schema.String,
	startedMs: Schema.Number,
	durationMs: Schema.Number,
	pages: Schema.Number,
	errors: Schema.Number,
	entryPath: Schema.String,
	/** `"Chrome · macOS"`, `''` when the SDK sent neither. */
	device: Schema.String,
})
export type UserSessionItem = typeof UserSessionItem.Type

export const UserEventItem = Schema.Struct({
	atMs: Schema.Number,
	name: Schema.String,
	/** `browser`, `server`, `mobile` or `trace`. */
	source: Schema.String,
	service: Schema.String,
	/** The page path, else the first properties as `key=value`. */
	detail: Schema.String,
})
export type UserEventItem = typeof UserEventItem.Type

/** One MCP session of the user on one server: issued by the server, or split from its requests. */
export const UserMcpSessionItem = Schema.Struct({
	service: Schema.String,
	sessionId: Schema.String,
	source: McpSessionSource,
	client: Schema.String,
	kind: McpClientKind,
	requests: Schema.Number,
	calls: Schema.Number,
	errors: Schema.Number,
	tools: Schema.Number,
	firstSeenMs: Schema.Number,
	lastSeenMs: Schema.Number,
})
export type UserMcpSessionItem = typeof UserMcpSessionItem.Type

export const UserActivityKind = Schema.Literals(["session", "event", "mcp", "error", "request", "log"])
export type UserActivityKind = typeof UserActivityKind.Type

export const UserActivityItem = Schema.Struct({
	kind: UserActivityKind,
	atMs: Schema.Number,
	service: Schema.String,
	title: Schema.String,
	detail: Schema.String,
	tone: Schema.Literals(["crit", "warn", "neutral"]),
	/** The replay or MCP session the row opens; `null` for a row with no page. */
	sessionId: Schema.NullOr(Schema.String),
	/** The trace a request or log row opens; `null` when it has none. */
	traceId: Schema.NullOr(Schema.String),
})
export type UserActivityItem = typeof UserActivityItem.Type

export class UserActivityResponse extends Schema.Class<UserActivityResponse>("UserActivityResponse")({
	sessions: Schema.Array(UserSessionItem),
	events: Schema.Array(UserEventItem),
	mcpSessions: Schema.Array(UserMcpSessionItem),
	/** Sessions, events, MCP sessions, failed or slow requests and warnings merged, the latest first, capped. */
	activity: Schema.Array(UserActivityItem),
}) {}

/** One request of the user: an entry-point span (Server/Consumer or a root). */
export const UserTraceItem = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	atMs: Schema.Number,
	/** The entry span's name, e.g. `GET /checkout`. */
	spanName: Schema.String,
	service: Schema.String,
	durationMs: Schema.Number,
	/** `Ok`, `Error` or `Unset`. */
	status: Schema.String,
	isRoot: Schema.Boolean,
})
export type UserTraceItem = typeof UserTraceItem.Type

export class UserTracesResponse extends Schema.Class<UserTracesResponse>("UserTracesResponse")({
	/** The latest first, capped. */
	traces: Schema.Array(UserTraceItem),
}) {}

export const UserLogItem = Schema.Struct({
	atMs: Schema.Number,
	/** The SDK's severity text, else the OTel level of its number. */
	severity: Schema.String,
	service: Schema.String,
	body: Schema.String,
	/** `''` for a log outside a trace. */
	traceId: Schema.String,
})
export type UserLogItem = typeof UserLogItem.Type

export class UserLogsResponse extends Schema.Class<UserLogsResponse>("UserLogsResponse")({
	/** The latest first, capped. */
	logs: Schema.Array(UserLogItem),
}) {}

export class UsersInternalApiGroup extends HttpApiGroup.make("usersInternal")
	.add(
		HttpApiEndpoint.post("list", "/list", {
			payload: UsersListRequest,
			success: UsersListResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("facets", "/facets", {
			payload: UsersFacetsRequest,
			success: UsersFacetsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("profile", "/profile", {
			payload: UserDetailRequest,
			success: UserProfileResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("activity", "/activity", {
			payload: UserDetailRequest,
			success: UserActivityResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("traces", "/traces", {
			payload: UserDetailRequest,
			success: UserTracesResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("logs", "/logs", {
			payload: UserDetailRequest,
			success: UserLogsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.prefix("/internal/users")
	.middleware(SessionAuthorization)
	.annotate(AuditedRead, "telemetry.read") {}
