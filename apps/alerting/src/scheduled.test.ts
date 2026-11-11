import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Latch, Layer, Order, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { env as workerEnv } from "../test/stubs/cloudflare-workers"
import { ALERTING_CRONS, scheduleFor } from "./schedule"
import {
	catchTickFailure,
	layerTick,
	scheduledTickNames,
	selectLaneProgram,
	tickProgramsFrom,
	type ScheduledTickPrograms,
} from "./scheduled"

/** Every tick recording its name when it runs, with `overrides` swapped in. */
const recordingTicks = (
	calls: Array<string>,
	overrides: Partial<ScheduledTickPrograms> = {},
): ScheduledTickPrograms => ({
	...tickProgramsFrom((name) => Effect.sync(() => calls.push(name)).pipe(Effect.asVoid)),
	...overrides,
})

describe("alerting Effect root", () => {
	it.effect("acquires the production layer graph", () =>
		Effect.scoped(Layer.build(layerTick(workerEnv))).pipe(Effect.asVoid),
	)

	it.effect("runs every tick in exactly one lane of one cron, and no lane idle", () =>
		Effect.gen(function* () {
			const perLane: Array<Array<string>> = []
			for (const cron of ALERTING_CRONS) {
				for (const lane of scheduleFor(cron)?.lanes ?? []) {
					const calls: Array<string> = []
					yield* selectLaneProgram(cron, lane, recordingTicks(calls))
					perLane.push(calls)
				}
			}
			expect(Arr.sort(Arr.flatten(perLane), Order.String)).toEqual(
				Arr.sort(scheduledTickNames, Order.String),
			)
			expect(Arr.every(perLane, (calls) => calls.length > 0)).toBe(true)
		}),
	)

	it("keeps every cron within the Workers limit of six simultaneous connections", () => {
		for (const cron of ALERTING_CRONS) {
			expect(scheduleFor(cron)?.lanes.length ?? 0).toBeLessThanOrEqual(6)
		}
	})

	it.effect("never starts fixVerification before the error tick completes", () =>
		Effect.gen(function* () {
			const calls: Array<string> = []
			const errorGate = yield* Latch.make(false)
			const ticks = recordingTicks(calls, {
				error: errorGate.await.pipe(
					Effect.andThen(Effect.sync(() => calls.push("error"))),
					Effect.asVoid,
				),
			})
			const fiber = yield* Effect.forkChild(selectLaneProgram("* * * * *", "error", ticks))
			yield* Effect.yieldNow
			yield* Effect.yieldNow
			expect(calls).not.toContain("fixVerification")
			yield* errorGate.open
			yield* Fiber.join(fiber)
			expect(calls).toEqual(["error", "fixVerification"])
		}),
	)

	it.effect("fails closed for an unknown cron or a lane of another cron", () =>
		Effect.gen(function* () {
			const calls: Array<string> = []
			yield* selectLaneProgram("1 2 3 4 5", "alert", recordingTicks(calls))
			yield* selectLaneProgram("0 * * * *", "alert", recordingTicks(calls))
			yield* selectLaneProgram("* * * * *", "nope", recordingTicks(calls))
			expect(calls).toEqual([])
		}),
	)

	it.effect("interrupts a lane at its cron's deadline and completes the fire", () =>
		Effect.gen(function* () {
			const calls: Array<string> = []
			const ticks = recordingTicks(calls, {
				alert: Effect.never.pipe(
					Effect.onInterrupt(() => Effect.sync(() => calls.push("alert interrupted"))),
				),
			})
			const fiber = yield* Effect.forkChild(selectLaneProgram("* * * * *", "alert", ticks))
			yield* TestClock.adjust("109 seconds")
			expect(fiber.pollUnsafe()).toBeUndefined()
			yield* TestClock.adjust("1 second")
			const exit = yield* Fiber.await(fiber)
			expect(Exit.isSuccess(exit)).toBe(true)
			expect(calls).toEqual(["alert interrupted"])
		}),
	)

	it.effect("isolates ordinary tick failures", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.fail("boom").pipe(
				catchTickFailure("expected test failure"),
				Effect.exit,
			)
			expect(Exit.isSuccess(exit)).toBe(true)
		}),
	)

	it.effect("preserves interrupt-only causes for graceful worker teardown", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.interrupt.pipe(catchTickFailure("must not be logged"), Effect.exit)
			expect(Exit.isFailure(exit)).toBe(true)
			if (Exit.isFailure(exit)) {
				expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
			}
		}),
	)
})
