import { AsyncData } from "foldkit"
import { Result } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { Message } from "./model"
import { init, update } from "./update"

const member = (id: string) => ({ id, name: id, identifier: `${id}@acme.test`, role: "org:member", createdAtMs: 0, isCurrentUser: false })

describe("members tab", () => {
	test("a failed Load more keeps the rows and frees the button for another try", () => {
		const firstPage = { rows: Array.from({ length: 10 }, (_, index) => member(`user_${index}`)), total: 12 }
		const loaded = update(init(true).model, Message.CompletedFetchMembers({ page: 1, result: Result.succeed(firstPage) })).model
		const fetching = update(loaded, Message.ClickedLoadMoreMembers())
		expect(fetching.commands?.map((command) => command.name)).toEqual(["FetchClerkMemberships"])
		const failed = update(
			fetching.model,
			Message.CompletedFetchMembers({ page: 2, result: Result.fail(toLoadFailure(new Error("rate limited"))) }),
		).model
		const data = AsyncData.getOrElse(failed.members, () => null)
		expect(data?.rows).toHaveLength(10)
		expect(data?.isFetchingMore).toBe(false)
		expect(update(failed, Message.ClickedLoadMoreMembers()).commands?.map((command) => command.name)).toEqual([
			"FetchClerkMemberships",
		])
	})
})
