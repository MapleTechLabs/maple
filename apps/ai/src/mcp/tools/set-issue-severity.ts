import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { SetIssueSeverityOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { resolveActor } from "../lib/resolve-actor"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { issueIdParam, issueNotFound, persistenceFailed } from "./error-issue-shared"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import { IssueSeverity } from "@maple/domain/http"

export function registerSetIssueSeverityTool(server: McpToolRegistrar) {
	server.define({
		name: "set_issue_severity",
		description:
			"Set or clear the triage severity of an issue. Severity drives escalation routing (critical/high/medium/low). API-key agents write with 'ai' precedence, so a human's manual severity is never overwritten; human sessions write a sticky manual override.",
		parameters: Schema.Struct({
			issue_id: issueIdParam("The issue ID (from list_error_issues)"),
			severity: P.oneOf([...IssueSeverity.literals, "none"], "Target severity, or 'none' to clear"),
			note: P.optionalText("Optional reasoning / context, stored on the severity event"),
		}),
		output: SetIssueSeverityOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Setting issue severity"],
		handler: Effect.fn("McpTool.setIssueSeverity")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			// `none` clears the severity (null).
			const target = params.severity === "none" ? null : params.severity

			const { actorId, isAgent } = yield* resolveActor(tenant)
			// Agent identities (pinned via API key/header or derived from the MCP client name)
			// write with "ai" precedence so they never clobber a human's manual override.
			const source: "ai" | "manual" = isAgent ? "ai" : "manual"
			const workflow = yield* ErrorIssueWorkflowService
			const issue = yield* workflow
				.setSeverity(tenant.orgId, actorId, params.issue_id, target, { note: params.note, source })
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
						"@maple/http/errors/ErrorPersistenceError": persistenceFailed("set_issue_severity"),
					}),
				)

			return {
				id: issue.id,
				severity: issue.severity,
				severitySource: issue.severitySource,
				applied: issue.severity === target,
				workflowState: issue.workflowState,
				serviceName: issue.serviceName,
				...(params.note === undefined ? undefined : { note: params.note }),
			}
		}),
		render: (output) => ({
			title: output.applied
				? "Issue severity updated"
				: "Severity not applied (manual override in place)",
			blocks: [
				doc.fields([
					["ID", output.id],
					[
						"Severity",
						`${output.severity ?? "unset"}${output.severitySource ? ` (${output.severitySource})` : ""}`,
					],
					["State", output.workflowState],
					["Service", output.serviceName],
					["Note", output.note],
				]),
			],
		}),
	})
}
