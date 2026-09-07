import { assert, describe, it } from "@effect/vitest"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Effect, Exit, Schema } from "effect"
import { durableStep } from "./durable-step"

/** What alchemy's step service records for each `do`, standing in for Cloudflare's step transaction. */
interface RecordedStep {
	readonly name: string
	readonly retries: Cloudflare.WorkflowStepConfig["retries"]
	readonly timeout: Cloudflare.WorkflowStepConfig["timeout"]
}

/** The step's Effect as `task` hands it over, with the body context already provided. */
const stepEffect = <T>(options: Cloudflare.WorkflowTaskOptions<T, any, any>): Effect.Effect<T> =>
	// SAFETY: alchemy's own step wrapper makes the same narrowing before it runs the Effect.
	options.effect as Effect.Effect<T>

const recordingStep = (recorded: Array<RecordedStep>): Cloudflare.WorkflowStep["Service"] => ({
	do: (options) =>
		Effect.suspend(() => {
			recorded.push({ name: options.name, retries: options.retries, timeout: options.timeout })
			return stepEffect(options)
		}),
	sleep: () => Effect.void,
	sleepUntil: () => Effect.void,
	waitForEvent: () => Effect.die("unused"),
})

class StepFailure extends Schema.TaggedError<StepFailure>()("StepFailure", { message: Schema.String }) {}

describe("durableStep", () => {
	it.effect("runs the Effect inside the step service and hands its value back", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedStep> = []
			const value = yield* durableStep("claim", Effect.succeed(42)).pipe(
				Effect.provideService(Cloudflare.WorkflowStep, recordingStep(recorded)),
			)
			assert.strictEqual(value, 42)
			assert.deepStrictEqual(recorded, [{ name: "claim", retries: undefined, timeout: undefined }])
		}),
	)

	it.effect("forwards the retry and timeout config to the step service", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedStep> = []
			const config = {
				retries: { limit: 5, delay: "2 seconds", backoff: "exponential" as const },
				timeout: "5 minutes",
			}
			yield* durableStep("finalize", Effect.void, config).pipe(
				Effect.provideService(Cloudflare.WorkflowStep, recordingStep(recorded)),
			)
			assert.deepStrictEqual(recorded, [{ name: "finalize", ...config }])
		}),
	)

	it.effect("a failing Effect rejects the step, so Cloudflare retries it", () =>
		Effect.gen(function* () {
			const failure = new StepFailure({ message: "ClickHouse 500" })
			const exit = yield* durableStep("m1:create", Effect.fail(failure)).pipe(
				Effect.provideService(Cloudflare.WorkflowStep, recordingStep([])),
				Effect.exit,
			)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit)) {
				assert.isDefined(exit.cause.reasons.find(Cause.isDieReason))
				assert.strictEqual(Cause.squash(exit.cause), failure)
			}
		}),
	)
})
