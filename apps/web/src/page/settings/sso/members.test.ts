import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { fetchAllMembers } from "./update"

/** `total` memberships served 100 per page, recording which pages were asked for. */
const org = (total: number, asked: Array<number>) => (initialPage: number) =>
	Effect.sync(() => {
		asked.push(initialPage)
		const start = (initialPage - 1) * 100
		return {
			total_count: total,
			data: Arr.map(Arr.range(start, Math.min(start + 100, total) - 1), (i) => ({
				publicUserData: {
					userId: `user_${i}`,
					identifier: `u${i}@acme.com`,
					firstName: null,
					lastName: null,
				},
			})),
		}
	})

describe("fetchAllMembers", () => {
	it.effect("reads every page past the first, so member 250 is offered", () => {
		const asked: Array<number> = []
		return Effect.gen(function* () {
			const members = yield* fetchAllMembers(org(250, asked))
			assert.strictEqual(members.length, 250)
			assert.strictEqual(members[249]?.userId, "user_249")
			assert.deepStrictEqual(
				Arr.sort(asked, (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0)),
				[1, 2, 3],
			)
		})
	})

	it.effect("stops after one page for a small org", () => {
		const asked: Array<number> = []
		return Effect.gen(function* () {
			const members = yield* fetchAllMembers(org(12, asked))
			assert.strictEqual(members.length, 12)
			assert.deepStrictEqual(asked, [1])
		})
	})

	it.effect("caps a very large org at 50 pages", () => {
		const asked: Array<number> = []
		return Effect.gen(function* () {
			yield* fetchAllMembers(org(9_000, asked))
			assert.strictEqual(asked.length, 50)
		})
	})
})
