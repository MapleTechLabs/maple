/**
 * The audit Workflow's port over alchemy's handle: start one instance per run (instance id = run id)
 * and terminate it on cancel. The handle turns every binding error into a defect; they become typed here.
 */
import {
	type SecurityAuditWorkflowControl,
	WorkflowCancelError,
	WorkflowStartError,
} from "@maple/backend/platform/bindings"
import type { SecurityAuditWorkflowPayload } from "@maple/domain/security-audit"
import type * as Cloudflare from "@alchemy.run/cloudflare"
import { Cause, Effect, Predicate } from "effect"

/** Statuses after which an instance runs no more steps. */
const FINISHED = new Set(["complete", "errored", "terminated"])

/** The thrown error's message; `tryPromise` wraps it, so the original sits on `cause`. */
const defectMessage = (defect: unknown): string => {
	const own =
		Predicate.hasProperty(defect, "message") && Predicate.isString(defect.message) ? defect.message : ""
	const inner = Predicate.hasProperty(defect, "cause") ? defectMessage(defect.cause) : ""
	return [own, inner].filter((m) => m.length > 0).join(": ")
}

/** The error the binding threw: alchemy's `tryPromise` wraps it in an `UnknownError`. */
const bindingError = (defect: unknown) => (Cause.isUnknownError(defect) ? defect.cause : defect)

/**
 * `get` on an id with no instance throws the binding code `instance.not_found`, bare or as
 * `(instance.not_found) <message>`. Any other error (a 404, a misbound binding) is not "gone".
 */
const isInstanceNotFound = (defect: unknown) => {
	const error = bindingError(defect)
	if (!Predicate.hasProperty(error, "message") || !Predicate.isString(error.message)) return false
	return error.message === "instance.not_found" || error.message.startsWith("(instance.not_found)")
}

const cancelFailed = (runId: string, cause: unknown) =>
	new WorkflowCancelError({
		message: `security audit workflow ${runId} could not be terminated: ${defectMessage(cause) || "unknown error"}`,
		cause,
	})

/** The slice of alchemy's `WorkflowHandle` the port uses; tests pass a fake of just this. */
export interface AuditWorkflowHandle {
	readonly create: (
		options: Cloudflare.WorkflowInstanceCreateOptions<SecurityAuditWorkflowPayload>,
	) => Effect.Effect<unknown>
	readonly get: (instanceId: string) => Effect.Effect<AuditWorkflowInstance>
}

export interface AuditWorkflowInstance {
	readonly terminate: () => Effect.Effect<void>
	readonly status: () => Effect.Effect<{ readonly status: string }>
}

export const securityAuditWorkflowControl = (handle: AuditWorkflowHandle): SecurityAuditWorkflowControl => ({
	create: (params) =>
		handle.create({ id: params.runId, params }).pipe(
			Effect.asVoid,
			Effect.catchDefect((cause) =>
				Effect.fail(
					new WorkflowStartError({
						message:
							cause instanceof Error ? cause.message : "security audit workflow create failed",
						cause,
					}),
				),
			),
		),
	cancel: (runId) =>
		handle.get(runId).pipe(
			Effect.catchDefect((cause) =>
				isInstanceNotFound(cause) ? Effect.succeed(null) : Effect.fail(cancelFailed(runId, cause)),
			),
			Effect.flatMap((instance) =>
				instance === null
					? Effect.void
					: instance.terminate().pipe(
							// Terminating a finished instance throws; finished is what cancel wants.
							Effect.catchDefect((cause) =>
								instance.status().pipe(
									Effect.catchDefect(() => Effect.fail(cancelFailed(runId, cause))),
									Effect.flatMap(({ status }) =>
										FINISHED.has(status)
											? Effect.void
											: Effect.fail(cancelFailed(runId, cause)),
									),
								),
							),
						),
			),
		),
})
