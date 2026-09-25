import { McpQueryError, type McpToolRegistrar } from "./types"
import { formatNumber, truncate } from "../lib/format"
import { Effect, Schema } from "effect"
import { ListErrorIssuesOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc, type NextCall } from "../lib/tool-doc"
import { actorLabel } from "./error-issue-shared"
import { ErrorIssueReadModelsService } from "@maple/backend/services/errors/ErrorIssueReadModelsService"
import { IssueKind, IssueSeverity, WorkflowState } from "@maple/domain/http"

type Output = typeof ListErrorIssuesOutput.Type
type AnyRow = Output["issues"][number]

/**
 * One-cell summary of whether this issue has been fixed before.
 *
 * `regression_count` alone reads as a number with no meaning; pairing it with
 * the date it was last resolved is what tells an agent to read the event log
 * before starting a fresh investigation.
 */
const describeFixHistory = (issue: {
	readonly regressionCount: number
	readonly lastResolvedAt: string | null
}): string => {
	if (issue.regressionCount === 0) return issue.lastResolvedAt === null ? "—" : "fixed once"
	const when = issue.lastResolvedAt === null ? "" : `, last fixed ${issue.lastResolvedAt.slice(0, 10)}`
	return `regressed ${issue.regressionCount}x${when}`
}

const stateCell = (issue: AnyRow): string =>
	issue.hasOpenIncident ? `${issue.workflowState} (incident)` : issue.workflowState

const exceptionCell = (issue: AnyRow): string =>
	truncate(
		issue.errorLabel ||
			("exceptionType" in issue ? `${issue.exceptionType}: ${issue.exceptionMessage}` : ""),
		50,
	)

const issueTable = (output: Output) => {
	const rows: ReadonlyArray<AnyRow> = output.issues
	if (output.compact) {
		return doc.table(
			["Issue ID", "State", "Severity", "Service", "Exception", "Events", "Last seen", "Fingerprint"],
			rows.map((i) => [
				i.id,
				stateCell(i),
				i.severity ?? "—",
				i.serviceName,
				exceptionCell(i),
				formatNumber(i.occurrenceCount),
				i.lastSeenAt.slice(0, 19),
				i.fingerprintHash,
			]),
		)
	}
	return doc.table(
		[
			// Full id, not a prefix. The 8-char truncation this used to render was
			// pasted into error_detail as if it were a fingerprint, a different identity space.
			"Issue ID",
			"Kind",
			"State",
			"Severity",
			"Priority",
			"Service",
			"Exception",
			"Events",
			// An agent that cannot see an issue was fixed before will investigate it as if
			// it were new. This column is why the same bug used to get fixed more than once.
			"History",
			"Last seen",
			"Assigned",
			"Holder",
			// The warehouse identity, so an issue goes straight to error_detail.
			"Fingerprint",
		],
		rows.map((i) => [
			i.id,
			i.kind,
			stateCell(i),
			i.severity ?? "—",
			"priority" in i ? String(i.priority) : "—",
			i.serviceName,
			exceptionCell(i),
			formatNumber(i.occurrenceCount),
			describeFixHistory(i),
			i.lastSeenAt.slice(0, 19),
			"assignedActor" in i && i.assignedActor !== null ? actorLabel(i.assignedActor) : "—",
			"leaseHolder" in i && i.leaseHolder !== null ? actorLabel(i.leaseHolder) : "—",
			i.fingerprintHash,
		]),
	)
}

const MAX_LIMIT = 200

/** The call's filters as arguments, to repeat it with a bigger page. */
const filterArgs = (output: Output) => ({
	workflow_state: output.filters.workflowState,
	severity: output.filters.severity,
	kind: output.filters.kind,
	service: output.filters.service,
	last_seen_after: output.filters.lastSeenAfter,
	compact: output.compact ? true : undefined,
	include_archived: output.filters.includeArchived ? true : undefined,
})

const nextCalls = (output: Output): ReadonlyArray<NextCall> => {
	const rows: ReadonlyArray<AnyRow> = output.issues
	const calls: Array<NextCall> = []
	for (const issue of rows.filter((i) => i.workflowState === "regressed").slice(0, 3)) {
		calls.push(
			doc.next(
				"list_error_issue_events",
				{ issue_id: issue.id },
				`this issue was fixed ${
					issue.lastResolvedAt === null ? "before" : `on ${issue.lastResolvedAt.slice(0, 10)}`
				} and regressed; read what was already tried before investigating it as new`,
			),
		)
	}
	const topError = rows.find((i) => i.kind === "error")
	if (topError !== undefined) {
		calls.push(
			doc.next(
				"error_detail",
				{ fingerprint: topError.fingerprintHash },
				"sample traces for the most recent issue",
			),
		)
	}
	for (const issue of rows.filter((i) => i.workflowState === "triage").slice(0, 3)) {
		calls.push(doc.next("claim_error_issue", { issue_id: issue.id }, "pick up this issue"))
		calls.push(
			doc.next("transition_error_issue", { issue_id: issue.id, to_state: "todo" }, "move to backlog"),
		)
	}
	return calls
}

export function registerListErrorIssuesTool(server: McpToolRegistrar) {
	server.define({
		name: "list_error_issues",
		description:
			"List persistent error issues (one per exception fingerprint, plus alert and integration issues) with workflow state, counts, assignment and lease holder. An issue survives new occurrences, so its state, notes and assignee persist. The `Issue ID` is what the issue tools take; the `Fingerprint` column is what error_detail takes. A `regressed` issue was fixed before and started firing again: read its events before investigating it as new.",
		parameters: Schema.Struct({
			workflow_state: P.optionalOneOf(
				WorkflowState.literals,
				"Filter by workflow state (default: all non-archived)",
			),
			severity: P.optionalOneOf(
				[...IssueSeverity.literals, "unset"],
				"Filter by triage severity, or 'unset' for untriaged issues",
			),
			kind: P.optionalOneOf(
				IssueKind.literals,
				"Filter by issue kind: error (fingerprint groups), alert (alert-rule incidents) or integration (third-party webhooks)",
			),
			service: P.service("Filter by service name"),
			last_seen_after: P.optionalTimestamp(
				'Only issues with an occurrence after this time, the way to ask "what fired recently" without paging the whole backlog',
			),
			compact: P.optionalFlag(
				"Narrow table: id, state, severity, service, exception, events, last seen, fingerprint. Omits assignment, lease and notes",
			),
			limit: P.limit({ default: 50, max: MAX_LIMIT, noun: "issues" }),
			include_archived: P.optionalFlag("Also return archived issues"),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ListErrorIssuesOutput,
		hints: { readOnly: true },
		phrases: ["Listing error issues", "Checking open issues"],
		handler: Effect.fn("McpTool.listErrorIssues")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const compact = params.compact === true
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				workflowState: params.workflow_state ?? "all",
				severity: params.severity ?? "all",
				service: params.service ?? "all",
				lastSeenAfter: params.last_seen_after ?? "none",
				compact,
				limit: params.limit,
			})
			const readModels = yield* ErrorIssueReadModelsService
			const includeArchived = params.include_archived === true

			const result = yield* readModels
				.listIssues(tenant.orgId, {
					workflowState: params.workflow_state,
					severity: params.severity,
					kind: params.kind,
					service: params.service,
					startTime: params.last_seen_after,
					limit: params.limit,
					includeArchived,
				})
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorPersistenceError": (error) =>
							Effect.fail(
								new McpQueryError({
									message: error.message,
									pipeName: "list_error_issues",
									cause: error,
								}),
							),
						...warehouseReadToMcpHandlers("list_error_issues"),
					}),
				)

			yield* Effect.annotateCurrentSpan("result.rowCount", result.issues.length)
			const issues = result.issues

			const filters: Output["filters"] = {
				...(params.workflow_state === undefined
					? undefined
					: { workflowState: params.workflow_state }),
				...(params.severity === undefined ? undefined : { severity: params.severity }),
				...(params.kind === undefined ? undefined : { kind: params.kind }),
				...(params.service === undefined ? undefined : { service: params.service }),
				...(params.last_seen_after === undefined
					? undefined
					: { lastSeenAfter: params.last_seen_after }),
				includeArchived,
				limit: params.limit,
			}

			return {
				compact,
				filters,
				total: issues.length,
				issues: compact
					? issues.map((i) => ({
							id: i.id,
							kind: i.kind,
							fingerprintHash: i.fingerprintHash,
							workflowState: i.workflowState,
							severity: i.severity,
							serviceName: i.serviceName,
							errorLabel: i.errorLabel,
							occurrenceCount: i.occurrenceCount,
							firstSeenAt: i.firstSeenAt,
							lastSeenAt: i.lastSeenAt,
							regressionCount: i.regressionCount,
							lastResolvedAt: i.lastResolvedAt,
							hasOpenIncident: i.hasOpenIncident,
						}))
					: issues.map((i) => ({
							id: i.id,
							kind: i.kind,
							fingerprintHash: i.fingerprintHash,
							workflowState: i.workflowState,
							priority: i.priority,
							severity: i.severity,
							severitySource: i.severitySource,
							serviceName: i.serviceName,
							errorLabel: i.errorLabel,
							exceptionType: i.exceptionType,
							exceptionMessage: i.exceptionMessage,
							topFrame: i.topFrame,
							occurrenceCount: i.occurrenceCount,
							firstSeenAt: i.firstSeenAt,
							lastSeenAt: i.lastSeenAt,
							assignedActor: i.assignedActor
								? {
										id: i.assignedActor.id,
										type: i.assignedActor.type,
										userId: i.assignedActor.userId,
										agentName: i.assignedActor.agentName,
										model: i.assignedActor.model,
										capabilities: i.assignedActor.capabilities,
									}
								: null,
							leaseHolder: i.leaseHolder
								? {
										id: i.leaseHolder.id,
										type: i.leaseHolder.type,
										userId: i.leaseHolder.userId,
										agentName: i.leaseHolder.agentName,
										model: i.leaseHolder.model,
										capabilities: i.leaseHolder.capabilities,
									}
								: null,
							leaseExpiresAt: i.leaseExpiresAt,
							notes: i.notes,
							hasOpenIncident: i.hasOpenIncident,
							regressionCount: i.regressionCount,
							lastResolvedAt: i.lastResolvedAt,
						})),
			}
		}),
		render: (output) => ({
			title: "Error Issues",
			scope: [
				["State", output.filters.workflowState],
				["Severity", output.filters.severity],
				["Kind", output.filters.kind],
				["Service", output.filters.service],
				["Last seen after", output.filters.lastSeenAfter],
				["Archived", output.filters.includeArchived ? "included" : undefined],
			],
			...(output.total === 0
				? {
						empty: {
							message: "No error issues found.",
							hints: [
								"Drop the workflow_state, severity, kind or service filters, or move last_seen_after earlier.",
								"Pass include_archived=true to include archived issues.",
							],
						},
					}
				: undefined),
			blocks: output.total === 0 ? [] : [doc.text(`Total: ${output.total}`), issueTable(output)],
			// A full page means the backlog may hold more; the service has no cursor here.
			...(output.total >= output.filters.limit
				? {
						truncation: {
							shown: output.total,
							noun: "issues",
							...(output.filters.limit < MAX_LIMIT
								? {
										next: doc.next(
											"list_error_issues",
											{ ...filterArgs(output), limit: MAX_LIMIT },
											"a bigger page",
										),
									}
								: undefined),
						},
					}
				: undefined),
			next: nextCalls(output),
		}),
	})
}
