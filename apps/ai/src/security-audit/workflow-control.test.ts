import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { type AuditWorkflowHandle, securityAuditWorkflowControl } from "./workflow-control"

/** Rejects the way alchemy's handle does: the binding's throw, wrapped by `tryPromise`, as a defect. */
const bindingThrows = (message: string) =>
	Effect.tryPromise(() => Promise.reject(new Error(message))).pipe(Effect.orDie)

const handle = (instance: {
	readonly get?: string
	readonly terminate?: string
	readonly status?: string
	readonly terminated?: Array<string>
}): AuditWorkflowHandle => ({
	create: () => Effect.void,
	get: (id) =>
		instance.get === undefined
			? Effect.succeed({
					terminate: () =>
						instance.terminate === undefined
							? Effect.sync(() => {
									instance.terminated?.push(id)
								})
							: bindingThrows(instance.terminate),
					status: () => Effect.succeed({ status: instance.status ?? "running" }),
				})
			: bindingThrows(instance.get),
})

describe("securityAuditWorkflowControl.cancel", () => {
	it.effect("terminates the run's instance", () =>
		Effect.gen(function* () {
			const terminated: Array<string> = []
			yield* securityAuditWorkflowControl(handle({ terminated })).cancel("run-1")
			assert.deepStrictEqual(terminated, ["run-1"])
		}),
	)

	it.effect("treats an instance that no longer exists or already finished as cancelled", () =>
		Effect.gen(function* () {
			const gone = yield* Effect.exit(
				securityAuditWorkflowControl(handle({ get: "instance.not_found" })).cancel("run-1"),
			)
			const finished = yield* Effect.exit(
				securityAuditWorkflowControl(
					handle({ terminate: "Cannot terminate a finished instance", status: "complete" }),
				).cancel("run-1"),
			)
			assert.deepStrictEqual([gone._tag, finished._tag], ["Success", "Success"])
		}),
	)

	it.effect("fails typed when a running instance cannot be terminated", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				securityAuditWorkflowControl(
					handle({ terminate: "internal error", status: "running" }),
				).cancel("run-1"),
			)
			const lookup = yield* Effect.flip(
				securityAuditWorkflowControl(handle({ get: "workflows binding unavailable" })).cancel(
					"run-1",
				),
			)
			assert.deepStrictEqual(
				[error._tag, error.message.includes("internal error"), lookup._tag],
				[
					"@maple/backend/platform/WorkflowCancelError",
					true,
					"@maple/backend/platform/WorkflowCancelError",
				],
			)
		}),
	)
})
