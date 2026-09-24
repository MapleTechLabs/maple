import type { ErrorIssueId } from "@maple/domain/http"
import { Cause, Effect, Exit } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { describe, expect, it } from "vitest"

import { BULK_CONCURRENCY, batchOutcome, forEachIssue, ISSUES_KEY, issueKey } from "./issue-batch"

const ids = (count: number) => Array.from({ length: count }, (_, i) => `issue-${i}` as ErrorIssueId)

const run = <A, E>(effect: Effect.Effect<A, E, Reactivity.Reactivity>) =>
	Effect.runPromise(Effect.provide(effect, Reactivity.layer))

describe("forEachIssue", () => {
	it("runs every issue and keeps each exit at its issue's position", async () => {
		const exits = await run(
			forEachIssue(ids(6), (issueId) =>
				issueId === "issue-2" ? Effect.fail(`nope ${issueId}`) : Effect.succeed(issueId),
			),
		)

		expect(exits).toHaveLength(6)
		expect(exits.map(Exit.isSuccess)).toEqual([true, true, false, true, true, true])
		expect(exits[3]).toEqual(Exit.succeed("issue-3"))
		expect(exits[2]).toEqual(Exit.fail("nope issue-2"))
	})

	it("runs issues in parallel, bounded by the bulk concurrency", async () => {
		let inFlight = 0
		let peak = 0
		await run(
			forEachIssue(ids(BULK_CONCURRENCY * 3), () =>
				Effect.gen(function* () {
					inFlight += 1
					yield* Effect.yieldNow
					peak = Math.max(peak, inFlight)
					inFlight -= 1
				}),
			),
		)

		expect(peak).toBe(BULK_CONCURRENCY)
	})

	it("invalidates the list and each issue once, after the whole batch", async () => {
		const invalidated: Array<string> = []
		await run(
			Effect.gen(function* () {
				const reactivity = yield* Reactivity.Reactivity
				reactivity.registerUnsafe([ISSUES_KEY], () => invalidated.push(ISSUES_KEY))
				reactivity.registerUnsafe([issueKey("issue-1" as ErrorIssueId)], () =>
					invalidated.push(issueKey("issue-1" as ErrorIssueId)),
				)
				yield* forEachIssue(ids(3), (issueId) =>
					Effect.sync(() => {
						expect(invalidated).toEqual([])
						return issueId
					}),
				)
			}),
		)

		expect(invalidated).toEqual([ISSUES_KEY, "errorIssue:issue-1"])
	})
})

describe("batchOutcome", () => {
	it("counts per-issue failures and surfaces the first one", () => {
		const seen: Array<Exit.Exit<unknown, unknown>> = []
		const failure = Exit.fail("second")
		const outcome = batchOutcome(
			3,
			Exit.succeed([Exit.succeed(1), failure, Exit.fail("third")]),
			(exit) => seen.push(exit),
		)

		expect(outcome).toEqual({ succeeded: 1, failed: 2, firstFailure: failure })
		expect(seen).toHaveLength(2)
	})

	it("treats a failed batch as every issue failing", () => {
		const exit = Exit.failCause(Cause.die(new Error("boom")))
		const outcome = batchOutcome(4, exit, () => {})

		expect(outcome).toEqual({ succeeded: 0, failed: 4, firstFailure: exit })
	})
})
