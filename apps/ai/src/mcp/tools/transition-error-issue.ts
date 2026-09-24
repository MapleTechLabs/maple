import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { WarehouseTimeInput } from "@maple/query-engine"
import { TransitionErrorIssueOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { resolveActorId } from "../lib/resolve-actor"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import {
	issueIdParam,
	issueNotFound,
	persistenceFailed,
	transitionRefused,
	validationFailed,
} from "./error-issue-shared"
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"
import {
	MACHINE_OWNED_WORKFLOW_STATES,
	WORKFLOW_STATE_ORDER,
	describeWorkflowTransitions,
} from "@maple/domain/http"

/**
 * What a caller may ask for. `regressed` and `verifying` are observations Maple's ticks make,
 * not states an agent asserts, so they are not in the enum.
 */
const SELECTABLE_STATES = WORKFLOW_STATE_ORDER.filter((state) => !MACHINE_OWNED_WORKFLOW_STATES.has(state))

export function registerTransitionErrorIssueTool(server: McpToolRegistrar) {
	server.define({
		name: "transition_error_issue",
		description: [
			"Move an error issue to a new workflow state.",
			`Valid transitions: ${describeWorkflowTransitions()}.`,
			"`regressed` and `verifying` are set by Maple's own ticks and cannot be requested here: `regressed` means a fixed error started firing from a build that postdates the fix, and `verifying` means a linked PR merged and the post-merge check is running.",
			"Do not move an issue to `done` yourself once a PR is linked: a merged PR opens a verification window that closes the issue for you when the error stops.",
		].join(" "),
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			to_state: P.oneOf(SELECTABLE_STATES, "Target workflow state"),
			note: P.optionalText("Optional reasoning / context, stored on the event"),
			snooze_until: Schema.optional(WarehouseTimeInput).annotate({
				description:
					"UTC datetime for a 'wontfix' transition. The issue re-opens as 'triage' if new events arrive after this time.",
			}),
		}),
		output: TransitionErrorIssueOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Updating an issue's status"],
		handler: Effect.fn("McpTool.transitionErrorIssue")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const actorId = yield* resolveActorId(tenant)
			const errors = yield* ErrorsService
			const issue = yield* errors
				.transitionIssue(tenant.orgId, actorId, params.issue_id, params.to_state, {
					note: params.note,
					snoozeUntil: params.snooze_until,
				})
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
						"@maple/http/errors/ErrorIssueTransitionError": transitionRefused("to_state"),
						"@maple/http/errors/ErrorValidationError": validationFailed("snooze_until"),
						"@maple/http/errors/ErrorPersistenceError":
							persistenceFailed("transition_error_issue"),
					}),
				)

			return {
				id: issue.id,
				workflowState: issue.workflowState,
				fromState: "",
				toState: issue.workflowState,
				assignedActorId: issue.assignedActor?.id ?? null,
				leaseHolderActorId: issue.leaseHolder?.id ?? null,
				snoozeUntil: issue.snoozeUntil,
				serviceName: issue.serviceName,
				exceptionType: issue.exceptionType,
				...(params.note === undefined ? undefined : { note: params.note }),
			}
		}),
		render: (output) => ({
			title: "Error issue transitioned",
			blocks: [
				doc.fields([
					["ID", output.id],
					["State", output.workflowState],
					["Service", output.serviceName],
					["Exception", output.exceptionType],
					["Snoozed until", output.snoozeUntil ?? undefined],
					["Note", output.note],
				]),
			],
		}),
	})
}
