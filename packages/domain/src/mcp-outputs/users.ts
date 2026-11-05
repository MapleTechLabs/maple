/**
 * Output schemas for the end-user MCP tools: the people an org's own apps identified with
 * `identify()` or a `user.id` attribute.
 */
import { Schema } from "effect"
import {
	UserActivityItem,
	UserIssueItem,
	UserListItem,
	UserMcpSessionItem,
	UserProfileItem,
	UserSessionItem,
} from "../http/users"
import { OutputTimeRange } from "./shared"

/** The filters a list_users call applied, echoed so a next page repeats them. */
export const ListUsersFilters = Schema.Struct({
	namespaces: Schema.optionalKey(Schema.Array(Schema.String)),
	search: Schema.optionalKey(Schema.String),
	hasErrors: Schema.optionalKey(Schema.Boolean),
	groups: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const ListUsersOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	users: Schema.Array(UserListItem),
	limit: Schema.Number,
	/** Pass back as `cursor` for the next page; absent on the last page. */
	nextCursor: Schema.optionalKey(Schema.String),
	filters: ListUsersFilters,
})

export const InspectUserOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	userId: Schema.String,
	namespaces: Schema.optionalKey(Schema.Array(Schema.String)),
	/** `null` when no signal in the window and namespaces carries the user. */
	profile: Schema.NullOr(UserProfileItem),
	/** Browser sessions, newest first, capped. */
	sessions: Schema.Array(UserSessionItem),
	/** MCP sessions on every MCP server in scope, latest first, capped. */
	mcpSessions: Schema.Array(UserMcpSessionItem),
	/** The issues the user hit, most hits first, capped. */
	issues: Schema.Array(UserIssueItem),
	/** `false` on a cluster whose error events cannot name a user: an empty `issues` says nothing. */
	issuesAttributed: Schema.Boolean,
	/** The timeline's failed requests, latest first. */
	failedRequests: Schema.Array(UserActivityItem),
})
