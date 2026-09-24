import { McpInvalidInputError, McpQueryError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { ClaimErrorIssueOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { resolveActorId } from "../lib/resolve-actor"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import {
	issueIdParam,
	issueNotFound,
	leaseConflict,
	persistenceFailed,
	transitionRefused,
} from "./error-issue-shared"
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"

const MIN_LEASE_SECONDS = 60
const MAX_LEASE_SECONDS = 7200

export function registerClaimErrorIssueTool(server: McpToolRegistrar) {
	server.define({
		name: "claim_error_issue",
		description:
			"Claim a lease on an error issue so other agents don't duplicate work. Issues in 'triage' or 'todo' auto-transition to 'in_progress' on claim. The lease (default 30 min) renews automatically whenever you act on the issue (transition it, comment, or set its severity) and is released when you move it to a terminal state or call release_error_issue.",
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			lease_duration_seconds: P.optionalNumber(
				`Lease TTL in seconds (${MIN_LEASE_SECONDS}..${MAX_LEASE_SECONDS}). Default: 1800 (30 min).`,
			),
		}),
		output: ClaimErrorIssueOutput,
		// Not idempotent: claiming again moves the lease expiry.
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Claiming an issue"],
		handler: Effect.fn("McpTool.claimErrorIssue")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const seconds = params.lease_duration_seconds
			if (seconds !== undefined && (seconds < MIN_LEASE_SECONDS || seconds > MAX_LEASE_SECONDS)) {
				return yield* new McpInvalidInputError({
					message: `Invalid lease_duration_seconds: ${seconds}. Must be between ${MIN_LEASE_SECONDS} and ${MAX_LEASE_SECONDS}.`,
					parameter: "lease_duration_seconds",
				})
			}

			const actorId = yield* resolveActorId(tenant)
			const errors = yield* ErrorsService
			const issue = yield* errors
				.claimIssue(
					tenant.orgId,
					actorId,
					params.issue_id,
					seconds === undefined ? undefined : seconds * 1000,
				)
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
						"@maple/http/errors/ErrorIssueLeaseConflictError": leaseConflict,
						"@maple/http/errors/ErrorIssueTransitionError": transitionRefused("issue_id"),
						"@maple/http/errors/ErrorPersistenceError": persistenceFailed("claim_error_issue"),
					}),
				)

			if (!issue.leaseHolder || !issue.leaseExpiresAt || !issue.claimedAt) {
				return yield* new McpQueryError({
					message: "Claim succeeded but lease fields were not populated on the issue.",
					pipeName: "claim_error_issue",
				})
			}

			return {
				id: issue.id,
				workflowState: issue.workflowState,
				leaseHolderActorId: issue.leaseHolder.id,
				leaseExpiresAt: issue.leaseExpiresAt,
				claimedAt: issue.claimedAt,
				holder: issue.leaseHolder.agentName ?? issue.leaseHolder.userId ?? actorId,
			}
		}),
		render: (output) => ({
			title: "Error issue claimed",
			blocks: [
				doc.fields([
					["ID", output.id],
					["State", output.workflowState],
					["Lease expires", output.leaseExpiresAt],
					["Holder", output.holder],
				]),
			],
		}),
	})
}
