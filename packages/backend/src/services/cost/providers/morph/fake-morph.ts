// A fake Morph for tests: the member budgets endpoint answered from a mutable world, every call
// recorded. Change `month` and `members` between pulls to move the month-to-date spend on.
import { Array as Arr, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import { CostConnectionStore } from "../../CostConnectionStore"
import { fakeCostEnvConfig } from "../fake-cost-env"

export interface FakeMorphMember {
	readonly userId: string
	/** Dollars as Morph writes them, `"12.34"`. */
	readonly spent: string
	readonly email?: string | null
}

export interface FakeMorph {
	status: number
	month: string
	/** The organization's members, or raw text for a malformed answer. */
	members: ReadonlyArray<FakeMorphMember> | string
	/** The next answer waits for this, with the members as they were when it was asked. */
	holdNext: Promise<void> | undefined
	/** Called as each request arrives, before any hold. */
	onRequest: (() => void) | undefined
	readonly urls: Array<string>
	readonly authorizations: Array<string | null>
}

export const makeFakeMorph = (overrides: Partial<FakeMorph> = {}): FakeMorph => ({
	status: 200,
	month: "2026-11",
	members: [],
	holdNext: undefined,
	onRequest: undefined,
	urls: [],
	authorizations: [],
	...overrides,
})

const fetchStub =
	(world: FakeMorph): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const url = new URL(href)
		world.urls.push(`${url.pathname}${url.search}`)
		world.authorizations.push(new Headers(init?.headers).get("authorization"))
		if (world.status !== 200) {
			return Response.json(
				{ error: { message: "Refused", type: "authentication_error" } },
				{ status: world.status },
			)
		}
		world.onRequest?.()
		const members = world.members
		const month = world.month
		const hold = world.holdNext
		world.holdNext = undefined
		if (hold !== undefined) await hold
		if (typeof members === "string") return new Response(members, { status: 200 })
		return Response.json({
			month,
			members: Arr.map(members, (member) => ({
				userId: member.userId,
				monthlyLimit: null,
				spent: member.spent,
				paused: false,
				email: member.email ?? `${member.userId}@example.com`,
				role: "member",
			})),
		})
	}

/** Everything the Morph cost services need, over the fake and a test database. */
export const fakeMorphDeps = (testDb: TestDb, world: FakeMorph) =>
	Layer.effect(CostConnectionStore, CostConnectionStore.make).pipe(
		Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, testDb.layer, Env.layer)),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub(world))),
		Layer.provide(fakeCostEnvConfig()),
	)
