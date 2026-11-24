// A fake Morph for tests: the usage endpoint answered from a mutable world, every call recorded.
import { Array as Arr, Layer, Option, Record as Rec, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import { CostConnectionStore } from "../../CostConnectionStore"
import { addDays } from "../../sync-plan"
import { fakeCostEnvConfig } from "../fake-cost-env"

export interface FakeMorphModel {
	readonly model: string
	readonly spend: number
	readonly includedInPlan?: boolean
}

export interface FakeMorph {
	status: number
	account: "organization" | "personal"
	/** Today, as Morph sees it: the default end, and the cap on any end. */
	today: string
	/** Each day's spend per model; a day not listed is zeros. Raw text for a malformed answer. */
	days: Readonly<Record<string, ReadonlyArray<FakeMorphModel>>> | string
	/** Another account behind some keys: by key, what differs from the world. */
	byKey: Readonly<Record<string, Partial<Pick<FakeMorph, "status" | "account" | "days">>>>
	readonly urls: Array<string>
	readonly authorizations: Array<string | null>
}

export const makeFakeMorph = (overrides: Partial<FakeMorph> = {}): FakeMorph => ({
	status: 200,
	account: "organization",
	today: "2026-11-21",
	days: {},
	byKey: {},
	urls: [],
	authorizations: [],
	...overrides,
})

const datesFrom = (start: string, end: string): ReadonlyArray<string> =>
	start > end ? [] : [start, ...datesFrom(addDays(start, 1), end)]

const fetchStub =
	(world: FakeMorph): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const url = new URL(href)
		world.urls.push(`${url.pathname}${url.search}`)
		const authorization = new Headers(init?.headers).get("authorization")
		world.authorizations.push(authorization)
		const seen = {
			...world,
			...Option.getOrElse(
				Rec.get(world.byKey, Str.replace("Bearer ", "")(authorization ?? "")),
				() => ({}),
			),
		}
		if (seen.status !== 200) {
			return Response.json({ error: "Refused" }, { status: seen.status })
		}
		const days = seen.days
		if (typeof days === "string") return new Response(days, { status: 200 })
		const requestedEnd = url.searchParams.get("end") ?? world.today
		const end = requestedEnd > world.today ? world.today : requestedEnd
		const start = url.searchParams.get("start") ?? `${Str.slice(0, 7)(end)}-01`
		const zeros = { requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
		return Response.json({
			account: seen.account,
			currency: "USD",
			start,
			end,
			total: { spend: 0, ...zeros },
			days: Arr.map(datesFrom(start, end), (date) => {
				const models = Option.getOrElse(Rec.get(days, date), () => [])
				return {
					date,
					spend: Arr.reduce(models, 0, (sum, model) => sum + model.spend),
					...zeros,
					models: Arr.map(models, (model) => ({
						model: model.model,
						includedInPlan: model.includedInPlan ?? false,
						spend: model.spend,
						requests: 3,
						inputTokens: 1000,
						cachedInputTokens: 400,
						outputTokens: 50,
					})),
				}
			}),
			models: [],
		})
	}

/** Everything the Morph cost services need, over the fake and a test database. */
export const fakeMorphDeps = (testDb: TestDb, world: FakeMorph) =>
	Layer.effect(CostConnectionStore, CostConnectionStore.make).pipe(
		Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, testDb.layer, Env.layer)),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub(world))),
		Layer.provide(fakeCostEnvConfig()),
	)
