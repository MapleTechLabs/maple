import type { UserActivityItem, UserProfileItem } from "@maple/domain/http"
import { ErrorIssueId } from "@maple/domain/http"
import { Array as Arr, Schema } from "effect"
import { AppRoute, hrefOf } from "../../../route"
import type {
	ActivityItem,
	UserDetail,
	UserIssue,
	UserLog,
	UserMcpSession,
	UserProfile,
	UserTrace,
} from "../data"
import type { ActivityData, IssuesData, LogsData, Search, TracesData } from "./model"
import { windowSearch } from "./update"

// The API's answers as the kit views draw them, with each row's link built from the app's routes.

/** One MCP session's page on its server, over the user page's window. */
export const mcpSessionHref = (service: string, sessionId: string, search: Search): string =>
	hrefOf(AppRoute.McpServerSession({ serviceName: service, sessionId, search: windowSearch(search) }))

/** The directory filtered to one group, over the user page's window. */
export const groupUsersHref = (groupId: string, search: Search): string =>
	hrefOf(AppRoute.Users({ search: { ...windowSearch(search), groups: [groupId] } }))

/** One replay's page. */
export const replayHref = (sessionId: string): string => hrefOf(AppRoute.Replay({ sessionId, search: {} }))

/** One issue's page over the user page's window, so its hits match the row that links it. */
export const issueHref = (issueId: string, search: Search): string =>
	hrefOf(AppRoute.ErrorIssue({ issueId: decodeIssueId(issueId), search: windowSearch(search) }))

/** One trace's page. */
export const traceHref = (traceId: string): string => hrefOf(AppRoute.Trace({ traceId, search: {} }))

const decodeIssueId = Schema.decodeSync(ErrorIssueId)

const EMPTY_ACTIVITY: ActivityData = { sessions: [], events: [], mcpSessions: [], activity: [] }

export const toProfile = (profile: UserProfileItem): UserProfile => ({
	userId: profile.userId,
	name: profile.name,
	email: profile.email,
	groupId: profile.groupId,
	groupName: profile.groupName,
	namespaces: Arr.dedupe(
		Arr.filter(
			Arr.map(profile.services, (service) => service.namespace),
			(namespace) => namespace !== "",
		),
	),
	firstSeenMs: profile.firstSeenMs,
	lastSeenMs: profile.lastSeenMs,
	sessions: profile.sessions,
	errors: profile.replayErrors,
	topRoute: profile.topRoute,
	signals: profile.signals,
	activity: profile.activity,
	traits: Arr.map(profile.traits, (trait) => [trait.key, trait.value] as const),
	visitorIds: profile.visitorIds,
	services: profile.services,
	devices: profile.devices,
	location: profile.country,
	recordedMs: profile.recordedMs,
	events: profile.events,
	distinctEvents: profile.distinctEvents,
	mcpCalls: profile.mcpCalls,
	requests: profile.requests,
	issues: profile.issues,
	issueHits: profile.issueHits,
	failedRate: profile.failedRate,
	p95Ms: profile.p95Ms,
	logs: profile.logs,
	traces: profile.traces,
})

/** The page a timeline row opens: an issue, a replay, an MCP session on its server, a trace, else none. */
export const activityHref = (item: UserActivityItem, search: Search): string | null => {
	if (item.issueId !== null) return issueHref(item.issueId, search)
	if (item.traceId !== null) return traceHref(item.traceId)
	if (item.sessionId === null) return null
	switch (item.kind) {
		case "session":
			return replayHref(item.sessionId)
		case "mcp":
			return mcpSessionHref(item.service, item.sessionId, search)
		default:
			return null
	}
}

/** What the Errors, Traces and Logs tabs draw; each read may still be out (no rows yet). */
export type TabReads = Readonly<{
	issues?: IssuesData | undefined
	traces: TracesData | undefined
	logs: LogsData | undefined
}>

export const toUserIssue = (issue: IssuesData["issues"][number], search: Search): UserIssue => ({
	issueId: issue.issueId,
	type: issue.type === "" ? "Unknown Error" : issue.type,
	message: issue.message,
	service: issue.service,
	hits: issue.hits,
	lastSeenMs: issue.lastSeenMs,
	status: issue.status,
	href: issue.issueId === null ? null : issueHref(issue.issueId, search),
})

/** Everything the kit body draws; the activity read may still be out (no rows yet). */
export const toUserDetail = (
	profile: UserProfileItem,
	activity: ActivityData | undefined,
	search: Search,
	tabs: TabReads = { traces: undefined, logs: undefined },
): UserDetail => {
	const data = activity ?? EMPTY_ACTIVITY
	return {
		...(activity === undefined && { activityPending: true }),
		profile: toProfile(profile),
		activity: Arr.map(data.activity, (item): ActivityItem => ({
			kind: item.kind,
			atMs: item.atMs,
			service: item.service,
			title: item.title,
			detail: item.detail,
			tone: item.tone,
			href: activityHref(item, search),
		})),
		sessions: Arr.map(data.sessions, (session) => ({
			sessionId: session.sessionId,
			service: session.service,
			startedMs: session.startedMs,
			durationMs: session.durationMs,
			pages: session.pages,
			errors: session.errors,
			entry: session.entryPath === "" ? "/" : session.entryPath,
			exit: null,
			device: session.device,
		})),
		issues: Arr.map(tabs.issues?.issues ?? [], (issue) => toUserIssue(issue, search)),
		traces: Arr.map(tabs.traces?.traces ?? [], (trace): UserTrace => ({
			traceId: trace.traceId,
			atMs: trace.atMs,
			rootSpan: trace.spanName,
			service: trace.service,
			durationMs: trace.durationMs,
			status: trace.status,
			isError: trace.status === "Error",
			href: traceHref(trace.traceId),
		})),
		logs: Arr.map(tabs.logs?.logs ?? [], (log): UserLog => ({
			atMs: log.atMs,
			severity: log.severity,
			service: log.service,
			body: log.body,
			href: log.traceId === "" ? null : traceHref(log.traceId),
		})),
		events: data.events,
		mcpSessions: Arr.map(data.mcpSessions, (session): UserMcpSession => ({
			service: session.service,
			sessionId: session.sessionId,
			client: session.client,
			kind: session.kind,
			calls: session.calls,
			errors: session.errors,
			tools: session.tools,
			firstSeenMs: session.firstSeenMs,
			lastSeenMs: session.lastSeenMs,
			href: mcpSessionHref(session.service, session.sessionId, search),
		})),
	}
}
