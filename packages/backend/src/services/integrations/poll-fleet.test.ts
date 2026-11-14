import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { pollFleet } from "./poll-fleet"

const onFailure = {
	message: "member poll failed",
	annotations: (member: number) => ({ member }),
	fallback: (member: number) => -member,
}

describe("pollFleet", () => {
	it.effect("replaces a failed or crashed member with its fallback and keeps the others", () =>
		Effect.gen(function* () {
			const results = yield* pollFleet(
				[1, 2, 3],
				(member) =>
					member === 2
						? Effect.fail("boom")
						: member === 3
							? Effect.die("crash")
							: Effect.succeed(member * 10),
				onFailure,
			)
			assert.deepStrictEqual(results, [10, -2, -3])
		}),
	)

	it.effect("lets an interrupted member stop the tick", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				pollFleet(
					[1, 2],
					(member) => (member === 2 ? Effect.interrupt : Effect.succeed(member)),
					onFailure,
				),
			)
			assert.isTrue(Exit.hasInterrupts(exit))
		}),
	)
})
