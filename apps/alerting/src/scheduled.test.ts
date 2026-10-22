import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Latch, Layer } from "effect"
import { TestClock } from "effect/testing"
import { env as workerEnv } from "../test/stubs/cloudflare-workers"
import { scheduleFor } from "./schedule"
import { layerTick, catchTickFailure, selectLaneProgram, type ScheduledTickPrograms } from "./scheduled"

const cronCases = [
	[
		"*/5 * * * *",
		[
			"anomaly",
			"cloudflareAnalytics",
			"gcpMetrics",
			"planetScale",
			"railwayMetrics",
			"prReviewPostMerge",
		],
	],
	["*/15 * * * *", ["digest", "supabaseInsights"]],
	["0 * * * *", ["serviceMapRollup", "supabaseDiscovery"]],
	["* * * * *", ["alert", "alertLongQuery", "error", "escalation", "fixVerification", "supabaseLogs"]],
] as const

/** Every tick recording its name when it runs, with `overrides` swapped in. */
const recordingTicks = (
	calls: Array<string>,
	overrides: Partial<ScheduledTickPrograms> = {},
): ScheduledTickPrograms => {
	const tick = (name: string) => Effect.sync(() => calls.push(name)).pipe(Effect.asVoid)
	return {
		alert: tick("alert"),
		alertLongQuery: tick("alertLongQuery"),
		anomaly: tick("anomaly"),
		cloudflareAnalytics: tick("cloudflareAnalytics"),
		digest: tick("digest"),
		error: tick("error"),
		escalation: tick("escalation"),
		fixVerification: tick("fixVerification"),
		gcpMetrics: tick("gcpMetrics"),
		planetScale: tick("planetScale"),
		prReviewPostMerge: tick("prReviewPostMerge"),
		railwayMetrics: tick("railwayMetrics"),
		serviceMapRollup: tick("serviceMapRollup"),
		supabaseDiscovery: tick("supabaseDiscovery"),
		supabaseLogs: tick("supabaseLogs"),
		supabaseInsights: tick("supabaseInsights"),
		...overrides,
	}
}

describe("alerting Effect root", () => {
	it.effect("acquires the production layer graph", () =>
		Effect.scoped(Layer.build(layerTick(workerEnv))).pipe(Effect.asVoid),
	)

	for (const [cron, expected] of cronCases) {
		it.effect(`runs each tick of ${cron} in exactly one of its lanes`, () =>
			Effect.gen(function* () {
				const lanes = scheduleFor(cron)?.lanes ?? []
				const perLane: Array<Array<string>> = []
				for (const lane of lanes) {
					const calls: Array<string> = []
					yield* selectLaneProgram(cron, lane, recordingTicks(calls))
					perLane.push(calls)
				}
				expect(perLane.flat().toSorted()).toEqual([...expected].toSorted())
				expect(perLane.every((calls) => calls.length > 0)).toBe(true)
			}),
		)
	}

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
