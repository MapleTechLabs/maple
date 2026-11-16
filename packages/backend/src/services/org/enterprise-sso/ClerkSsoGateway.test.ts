import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { scanClaimedDomains } from "./ClerkSsoGateway"

/** `total` connections, the last one serving `partner.io`; pages of 100 like Clerk's. */
const connections = (total: number) => (offset: number) =>
	Effect.succeed({
		totalCount: total,
		data: Arr.map(Arr.range(offset, Math.min(offset + 100, total) - 1), (i) => ({
			id: `ent_${i}`,
			domains: i === total - 1 ? ["Partner.io"] : [`org${i}.example`],
		})),
	})

describe("scanClaimedDomains", () => {
	it.effect("reads every page, so a connection on the last one still counts", () =>
		Effect.gen(function* () {
			const claimed = yield* scanClaimedDomains(connections(250), "ent_0", ["partner.io", "gmail.com"])
			assert.deepStrictEqual(claimed, ["partner.io"])
		}),
	)

	it.effect("ignores the caller's own connection", () =>
		Effect.gen(function* () {
			const claimed = yield* scanClaimedDomains(connections(3), "ent_2", ["partner.io"])
			assert.deepStrictEqual(claimed, [])
		}),
	)

	it.effect("fails closed when the scan cannot reach every connection", () =>
		Effect.gen(function* () {
			const error = yield* scanClaimedDomains(connections(250), "ent_0", ["partner.io"], 2).pipe(
				Effect.flip,
			)
			assert.strictEqual(error._tag, "@maple/backend/services/auth/ClerkRequestError")
		}),
	)
})
