/**
 * Pieces the error-issue tools share: the `issue_id` parameter and how the issue services'
 * typed failures reach a model.
 */
import { Effect, Schema } from "effect"
import {
	ErrorIssueId,
	MACHINE_OWNED_WORKFLOW_STATES,
	WORKFLOW_STATE_ORDER,
	type ErrorIssueLeaseConflictError,
	type ErrorIssueNotFoundError,
	type ErrorIssueTransitionError,
	type ErrorPersistenceError,
	type ErrorValidationError,
} from "@maple/domain/http"
import { McpInvalidInputError, McpQueryError } from "./types"

/**
 * The workflow states a caller may ask for. `regressed` and `verifying` are observations
 * Maple's ticks make, not states an agent asserts, so no issue tool publishes them.
 */
export const SELECTABLE_STATES = WORKFLOW_STATE_ORDER.filter(
	(state) => !MACHINE_OWNED_WORKFLOW_STATES.has(state),
)

/**
 * An issue id is a UUID. A fingerprint (a decimal UInt64 from find_errors) is the usual wrong
 * value, so the decode failure names where the right one comes from.
 */
export const issueIdParam = (description = "The error issue ID (from list_error_issues)") =>
	Schema.String.annotate({ description })
		.check(
			Schema.isUUID(undefined, {
				expected: "an issue UUID from list_error_issues (a fingerprint is not an issue id)",
			}),
		)
		.pipe(Schema.decodeTo(ErrorIssueId))

interface ActorLike {
	readonly type: "user" | "agent"
	readonly userId: string | null
	readonly agentName: string | null
}

/** `agent:<name>`, the user id, or `system` for events no actor made. */
export const actorLabel = (actor: ActorLike | null): string =>
	actor === null
		? "system"
		: actor.type === "agent"
			? `agent:${actor.agentName ?? "?"}`
			: (actor.userId ?? "user")

export const issueNotFound = (error: ErrorIssueNotFoundError) =>
	Effect.fail(
		new McpInvalidInputError({
			message: `${error.message}. Use an issue_id from list_error_issues.`,
			parameter: "issue_id",
		}),
	)

export const leaseConflict = (error: ErrorIssueLeaseConflictError) =>
	Effect.fail(new McpInvalidInputError({ message: error.message, parameter: "issue_id" }))

export const transitionRefused = (parameter: string) => (error: ErrorIssueTransitionError) =>
	Effect.fail(new McpInvalidInputError({ message: error.message, parameter }))

export const validationFailed = (parameter?: string) => (error: ErrorValidationError) =>
	Effect.fail(
		new McpInvalidInputError({
			message:
				error.details.length === 0 ? error.message : `${error.message}: ${error.details.join(", ")}`,
			...(parameter === undefined ? undefined : { parameter }),
		}),
	)

export const persistenceFailed = (tool: string) => (error: ErrorPersistenceError) =>
	Effect.fail(new McpQueryError({ message: error.message, pipeName: tool, cause: error }))
