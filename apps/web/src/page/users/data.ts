import type { McpClientKind } from "@maple/domain/mcp-clients"
import { Array as Arr } from "effect"
import { USER_DETAIL_TABS, type UserDetailTab } from "../../route/search"

// What the users pages draw: one row per end user the SDKs identified, and one user's profile.
// The ids come from `identify()` (session_replays, product_events) and `user.id` / `enduser.id`
// on spans and logs. Every row that comes from a service carries it, so the page can scope to a
// namespace (`service.namespace`): spans and logs carry theirs, replays and events resolve it
// through the service.

/** A signal Maple holds for a user, shown as a tag in the directory. */
export type UserSignal = "replay" | "traces" | "logs" | "events" | "mcp"

export type UserRow = Readonly<{
	userId: string
	name: string | null
	email: string | null
	groupId: string | null
	/** The `service.namespace`s this user's signals came from, most active first. */
	namespaces: ReadonlyArray<string>
	firstSeenMs: number
	lastSeenMs: number
	sessions: number
	errors: number
	requests: number
	topRoute: string | null
	signals: ReadonlyArray<UserSignal>
	/** Requests per day over the window, oldest first. */
	activity: ReadonlyArray<number>
}>

/** A service the user's signals came from; `signals` counts their sessions, events and MCP requests. */
export type UserService = Readonly<{ service: string; namespace: string; signals: number }>
export type UserDevice = Readonly<{ browser: string; os: string; sessions: number }>

/**
 * One user's profile. The request figures (`requests`, `failedRate`, `p95Ms`, `traces`, `logs`) are
 * `null` where the org's warehouse has no per-user rollup, and `issues` until issues by user land.
 */
export type UserProfile = Omit<UserRow, "requests"> &
	Readonly<{
		traits: ReadonlyArray<readonly [string, string]>
		visitorIds: ReadonlyArray<string>
		services: ReadonlyArray<UserService>
		devices: ReadonlyArray<UserDevice>
		location: string | null
		recordedMs: number
		events: number
		distinctEvents: number
		mcpCalls: number
		requests: number | null
		issues: number | null
		failedRate: number | null
		p95Ms: number | null
		logs: number | null
		traces: number | null
	}>

export type ActivityKind = "error" | "request" | "event" | "session" | "log" | "mcp"

export type ActivityItem = Readonly<{
	kind: ActivityKind
	atMs: number
	service: string
	title: string
	detail: string
	tone: "crit" | "warn" | "neutral"
	/** The page the row opens (a replay, an MCP session, a trace); `null` when it has none. */
	href: string | null
}>

export type UserSession = Readonly<{
	sessionId: string
	/** The browser SDK's `serviceName`. */
	service: string
	startedMs: number
	durationMs: number
	pages: number
	errors: number
	entry: string
	/** The last page, when the session recorded one. */
	exit: string | null
	device: string
}>

export type UserIssueStatus = "open" | "investigating" | "resolved"

export type UserIssue = Readonly<{
	issueId: string
	type: string
	message: string
	service: string
	hits: number
	lastSeenMs: number
	status: UserIssueStatus
}>

/** One request of the user: its entry span, and the trace page it opens. */
export type UserTrace = Readonly<{
	traceId: string
	atMs: number
	/** The entry span's name, e.g. `POST /api/checkout`. */
	rootSpan: string
	service: string
	durationMs: number
	/** `Ok`, `Error` or `Unset`. */
	status: string
	isError: boolean
	href: string
}>

/** One log line; `href` opens its trace, `null` outside one. */
export type UserLog = Readonly<{
	atMs: number
	severity: string
	service: string
	body: string
	href: string | null
}>

export type UserEvent = Readonly<{
	atMs: number
	name: string
	service: string
	/** `browser`, `server`, `mobile` or `trace`. */
	source: string
	detail: string
}>

/** One MCP session of the user on one MCP server, with the link to its session page. */
export type UserMcpSession = Readonly<{
	service: string
	sessionId: string
	client: string
	kind: McpClientKind
	calls: number
	errors: number
	tools: number
	firstSeenMs: number
	lastSeenMs: number
	href: string
}>

/** Everything the detail page reads for one user. */
export type UserDetail = Readonly<{
	profile: UserProfile
	activity: ReadonlyArray<ActivityItem>
	sessions: ReadonlyArray<UserSession>
	issues: ReadonlyArray<UserIssue>
	traces: ReadonlyArray<UserTrace>
	logs: ReadonlyArray<UserLog>
	events: ReadonlyArray<UserEvent>
	mcpSessions: ReadonlyArray<UserMcpSession>
}>

export const USER_TABS = USER_DETAIL_TABS
export type UserTab = UserDetailTab

/** One user's namespaces with how much of their activity each holds, for the rail and the scope. */
export const namespacesOf = (
	profile: Pick<UserProfile, "services">,
): ReadonlyArray<Readonly<{ name: string; signals: number }>> => {
	const named = Arr.filter(profile.services, (service) => service.namespace !== "")
	const totals = Arr.reduce(named, new Map<string, number>(), (sum, service) =>
		sum.set(service.namespace, (sum.get(service.namespace) ?? 0) + service.signals),
	)
	return Arr.map([...totals], ([name, signals]) => ({ name, signals })).toSorted(
		(a, b) => b.signals - a.signals,
	)
}

/** The user's display name: their name, else their email, else the raw id. */
export const userLabel = (user: Pick<UserRow, "name" | "email" | "userId">): string =>
	user.name ?? user.email ?? user.userId
