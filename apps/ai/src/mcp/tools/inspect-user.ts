import { Effect, Schema, Array as Arr } from "effect"
import { UserDetailRequest, type UserIssueItem, type UserProfileItem } from "@maple/domain/http"
import { InspectUserOutput } from "@maple/domain/mcp-outputs"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { UsersReadService } from "@maple/backend/services/users/UsersReadService"
import type { McpToolRegistrar } from "./types"
import { persistenceFailed } from "./error-issue-shared"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatDurationFromMs, formatNumber, formatPercent, truncate } from "../lib/format"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import { decodeUsersRequest, listFilter, nameAndEmail, userLabel } from "../lib/users"
import * as P from "../lib/params"
import { doc, type DocBlock, type NextCall } from "../lib/tool-doc"

const TOOL = "inspect_user"
const WINDOW = P.timeWindow({ defaultHours: 24 * 7, maxHours: MCP_DISCOVERY_MAX_HOURS })
/** Rows each section shows; the structured output keeps every row the reads returned. */
const SECTION_ROWS = 10

const at = (epochMs: number): string => formatWarehouseDateTime(epochMs)
const orDash = (value: string | null | undefined): string =>
	value === null || value === undefined || value === "" ? "-" : value
const countOrDash = (value: number | null): string => (value === null ? "-" : formatNumber(value))

const errorReads = {
	...warehouseReadToMcpHandlers(TOOL),
	"@maple/http/errors/ErrorPersistenceError": persistenceFailed(TOOL),
}

const profileFields = (profile: UserProfileItem): DocBlock =>
	doc.fields([
		["Name / email", nameAndEmail(profile)],
		["Group", profile.groupId ?? undefined],
		["First seen", at(profile.firstSeenMs)],
		["Last seen", at(profile.lastSeenMs)],
		["Signals", Arr.join(profile.signals, ", ")],
		[
			"Sessions",
			`${formatNumber(profile.sessions)} (${formatNumber(profile.replayErrors)} with recorded errors)`,
		],
		["Requests", countOrDash(profile.requests)],
		["Failed rate", profile.failedRate === null ? undefined : formatPercent(profile.failedRate)],
		["p95 latency", profile.p95Ms === null ? undefined : formatDurationFromMs(profile.p95Ms)],
		["Top route", profile.topRoute ?? undefined],
		["Traces", countOrDash(profile.traces)],
		["Logs", countOrDash(profile.logs)],
		[
			"Issues",
			profile.issues === null
				? "-"
				: `${formatNumber(profile.issues)} (${countOrDash(profile.issueHits)} hits)`,
		],
		["Events", `${formatNumber(profile.events)} (${formatNumber(profile.distinctEvents)} distinct)`],
		[
			"MCP",
			`${formatNumber(profile.mcpRequests)} requests, ${formatNumber(profile.mcpCalls)} tool calls`,
		],
		["Country", profile.country ?? undefined],
		[
			"Devices",
			profile.devices.length === 0
				? undefined
				: Arr.join(
						Arr.map(
							profile.devices,
							(device) => `${device.browser} on ${device.os} (${device.sessions})`,
						),
						", ",
					),
		],
		[
			"Traits",
			profile.traits.length === 0
				? undefined
				: truncate(
						Arr.join(
							Arr.map(profile.traits, (trait) => `${trait.key}=${trait.value}`),
							", ",
						),
						200,
					),
		],
	])

/** The issue's own id when it has one, else its fingerprint. */
const issueRef = (issue: UserIssueItem): string => issue.issueId ?? `fingerprint ${issue.fingerprintHash}`

/**
 * Why the failed-requests table is empty. Its rows come from the capped timeline, so only the
 * profile's uncapped figures can say the window truly had none.
 */
export const noFailedRequestsText = (
	profile: Readonly<{ requests: number | null; failedRate: number | null }> | null,
): string => {
	if (profile === null || profile.requests === null || profile.failedRate === null)
		return "No failed requests among the timeline's most recent rows."
	const failed = Math.round(profile.requests * profile.failedRate)
	return failed === 0
		? "No failed requests in the window."
		: `${formatNumber(failed)} failed ${failed === 1 ? "request" : "requests"} in the window, none among the timeline's most recent rows.`
}

export function registerInspectUserTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Inspect User",
		description:
			"One end user of the org's own apps (an id from `list_users`, or the `user.id` a span or session carries): identity, totals, the services and namespaces they touched, recent browser sessions, MCP sessions (server and session id), the error issues they hit, and their recent failed requests, with calls to open each.",
		parameters: Schema.Struct({
			user_id: P.text("The user's id as the app sent it (`identify()` or `user.id`), from list_users"),
			...WINDOW.fields,
			namespaces: P.optionalList("Only signals from these service namespaces (`service.namespace`)"),
		}),
		output: InspectUserOutput,
		hints: { readOnly: true },
		scopeFamily: "users",
		phrases: ["Looking up a user"],
		handler: Effect.fn("McpTool.inspectUser")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const namespaces = listFilter(params.namespaces)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
			const request = yield* decodeUsersRequest(UserDetailRequest, TOOL, {
				startTime: st,
				endTime: et,
				userId: params.user_id,
				...(namespaces !== undefined && { namespaces }),
			})
			const reads = yield* UsersReadService
			const [{ profile }, activity, issues] = yield* Effect.all(
				[
					reads.profile(tenant, request),
					reads.activity(tenant, request),
					reads.issues(tenant, request),
				],
				{ concurrency: 3 },
			).pipe(Effect.catchTags(errorReads))
			return {
				timeRange: { start: st, end: et },
				userId: params.user_id,
				...(namespaces !== undefined && { namespaces }),
				profile,
				sessions: activity.sessions,
				mcpSessions: activity.mcpSessions,
				issues: issues.issues,
				issuesAttributed: issues.attributed,
				failedRequests: Arr.filter(
					activity.activity,
					(entry) => entry.kind === "request" && entry.tone === "crit",
				),
			}
		}),
		render: (output) => {
			const { profile } = output
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			const scope = [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				["Namespaces", output.namespaces?.join(", ")],
			] as const
			if (profile === null) {
				return {
					title: `User ${output.userId}`,
					scope,
					empty: {
						message: `No signal in the window carries user ${output.userId}.`,
						hints: [
							"Widen start_time/end_time or drop namespaces.",
							"The id must match exactly what the app sent; find it with list_users.",
						],
					},
					blocks: [],
					next: [
						doc.next(
							"list_users",
							{ ...window, search: output.userId },
							"find the user's exact id",
						),
					],
				}
			}
			const label = userLabel(profile)
			const failedRequests = output.failedRequests.slice(0, SECTION_ROWS)
			const topIssue = output.issues[0]
			const firstFailure = output.failedRequests[0]
			const firstSession = output.sessions[0]
			const blocks: Array<DocBlock> = [
				profileFields(profile),
				doc.heading("Services"),
				profile.services.length === 0
					? doc.text("No services recorded.")
					: doc.table(
							["Service", "Namespace", "Signals"],
							Arr.map(profile.services.slice(0, SECTION_ROWS), (service) => [
								service.service,
								orDash(service.namespace),
								formatNumber(service.signals),
							]),
						),
				doc.heading("Recent sessions"),
				output.sessions.length === 0
					? doc.text("No browser sessions in the window.")
					: doc.table(
							[
								"Session",
								"Service",
								"Started",
								"Duration",
								"Pages",
								"Errors",
								"Entry",
								"Device",
							],
							Arr.map(output.sessions.slice(0, SECTION_ROWS), (session) => [
								session.sessionId,
								session.service,
								at(session.startedMs),
								formatDurationFromMs(session.durationMs),
								formatNumber(session.pages),
								formatNumber(session.errors),
								truncate(orDash(session.entryPath), 40),
								orDash(session.device),
							]),
						),
				doc.heading("MCP sessions"),
				output.mcpSessions.length === 0
					? doc.text("No MCP sessions in the window.")
					: doc.table(
							[
								"Server",
								"Session",
								"Client",
								"Kind",
								"Tool calls",
								"Tools",
								"Errors",
								"Last seen",
							],
							Arr.map(output.mcpSessions.slice(0, SECTION_ROWS), (session) => [
								session.service,
								session.sessionId,
								session.client,
								session.kind,
								formatNumber(session.calls),
								formatNumber(session.tools),
								formatNumber(session.errors),
								at(session.lastSeenMs),
							]),
						),
				doc.heading("Top issues"),
				!output.issuesAttributed
					? doc.text("This cluster's error events cannot name a user, so issues are unknown.")
					: output.issues.length === 0
						? doc.text("No errors named this user in the window.")
						: doc.table(
								["Issue", "Type", "Message", "Service", "Hits", "Status", "Last seen"],
								Arr.map(output.issues.slice(0, SECTION_ROWS), (issue) => [
									issueRef(issue),
									orDash(issue.type),
									truncate(issue.message, 60),
									issue.service,
									formatNumber(issue.hits),
									orDash(issue.status),
									at(issue.lastSeenMs),
								]),
							),
				doc.heading("Recent failed requests"),
				failedRequests.length === 0
					? doc.text(noFailedRequestsText(profile))
					: doc.table(
							["At", "Service", "Request", "Trace"],
							Arr.map(failedRequests, (request) => [
								at(request.atMs),
								request.service,
								truncate(request.title, 60),
								orDash(request.traceId),
							]),
						),
			]
			const next: Array<NextCall> = [
				...(firstFailure === undefined || firstFailure.traceId === null
					? []
					: [
							doc.next(
								"inspect_trace",
								{ trace_id: firstFailure.traceId, timestamp: at(firstFailure.atMs) },
								`the latest failed request of ${label}`,
							),
						]),
				...(topIssue === undefined
					? []
					: [
							doc.next(
								"error_detail",
								topIssue.issueId === null
									? { fingerprint: topIssue.fingerprintHash }
									: { issue_id: topIssue.issueId },
								`the error ${label} hit most`,
							),
						]),
				...(firstSession === undefined
					? []
					: [
							doc.next(
								"get_session_transcript",
								{ session_id: firstSession.sessionId },
								`what ${label} did in their latest session`,
							),
						]),
				doc.next(
					"search_sessions",
					{ ...window, user_id: output.userId },
					`every session of ${label}`,
				),
			]
			return { title: `User ${output.userId}`, scope, blocks, next }
		},
	})
}
