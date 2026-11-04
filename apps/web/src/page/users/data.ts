import { Array as Arr } from "effect"

// What the users pages draw: one row per end user the SDKs identified, and one user's profile.
// The ids come from `identify()` (session_replays, product_events) and `user.id` / `enduser.id`
// on spans and logs. Every row that comes from a service carries it, so the page can scope to a
// namespace (`service.namespace`): spans and logs carry theirs, replays and events resolve it
// through the service.

/** A signal Maple holds for a user, shown as a tag in the directory. */
export type UserSignal = "replay" | "traces" | "logs" | "events"

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

export type UserService = Readonly<{ service: string; namespace: string; spans: number }>
export type UserDevice = Readonly<{ browser: string; os: string; sessions: number }>

export type UserProfile = UserRow &
	Readonly<{
		traits: ReadonlyArray<readonly [string, string]>
		visitorIds: ReadonlyArray<string>
		services: ReadonlyArray<UserService>
		devices: ReadonlyArray<UserDevice>
		location: string | null
		recordedMs: number
		issues: number
		failedRate: number
		p95Ms: number
		orgP95Ms: number
		events: number
		distinctEvents: number
		logs: number
		traces: number
	}>

export type ActivityKind = "error" | "request" | "event" | "session" | "log"

export type ActivityItem = Readonly<{
	kind: ActivityKind
	atMs: number
	service: string
	title: string
	detail: string
	tone: "crit" | "warn" | "neutral"
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
	exit: string
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

export type UserTrace = Readonly<{
	traceId: string
	atMs: number
	rootSpan: string
	service: string
	durationMs: number
	spans: number
	status: string
	isError: boolean
}>

export type UserLog = Readonly<{ atMs: number; severity: string; service: string; body: string }>

export type UserEvent = Readonly<{
	atMs: number
	name: string
	service: string
	source: "browser" | "server" | "mobile"
	detail: string
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
}>

export const USER_TABS = ["activity", "sessions", "errors", "traces", "logs", "events"] as const
export type UserTab = (typeof USER_TABS)[number]

/** One user's namespaces with how much of their activity each holds, for the rail and the scope. */
export const namespacesOf = (
	profile: Pick<UserProfile, "services">,
): ReadonlyArray<Readonly<{ name: string; spans: number }>> => {
	const totals = Arr.reduce(profile.services, new Map<string, number>(), (sum, service) =>
		sum.set(service.namespace, (sum.get(service.namespace) ?? 0) + service.spans),
	)
	return Arr.map([...totals], ([name, spans]) => ({ name, spans })).toSorted((a, b) => b.spans - a.spans)
}

/** The user's display name: their name, else their email, else the raw id. */
export const userLabel = (user: Pick<UserRow, "name" | "email" | "userId">): string =>
	user.name ?? user.email ?? user.userId
