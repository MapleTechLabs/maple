import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { revisitData } from "./revisit"

const read = () => "read"

describe("revisitData", () => {
	test("loaded data stays on screen while it reads again", () => {
		expect(revisitData(AsyncData.Success({ data: 3 }), read)).toEqual({
			data: AsyncData.Refreshing({ data: 3 }),
			commands: ["read"],
		})
	})

	// A tab whose read failed came back to a skeleton for the whole retry, then the same error.
	test("a failure stays up while it retries", () => {
		const failed = AsyncData.Failure({ error: "upstream" })
		expect(revisitData(failed, read)).toEqual({ data: failed, commands: ["read"] })
	})

	test("a read in flight is not asked twice, and a cold field loads", () => {
		expect(revisitData(AsyncData.Loading(), read)).toEqual({ data: AsyncData.Loading(), commands: [] })
		expect(revisitData(AsyncData.Idle(), read)).toEqual({ data: AsyncData.Loading(), commands: ["read"] })
	})
})
