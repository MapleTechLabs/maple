import { describe, expect, it } from "@effect/vitest"
import { ExternalDataSourceId } from "@maple/domain/data-sources"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { DataSourceDevelopmentCallLimit } from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"
import { DataSourceCallBudgetLive } from "./DataSourceCallBudgetLive"
import { DataSourceCallBudget } from "./DataSourceDrivers"

const SOURCE = {
	id: Schema.decodeSync(ExternalDataSourceId)("00000000-0000-4000-8000-000000000002"),
	config: { _tag: "clerk", instance: "development" },
} as const

/** A binding that allows `allowed` calls, counting every `limit()` it sees. */
const binding = (allowed: number) => {
	const seen: Array<string> = []
	const layer = Layer.succeed(DataSourceDevelopmentCallLimit, {
		limit: (key: string) => Effect.sync(() => ({ success: seen.push(key) <= allowed })),
	})
	return { seen, layer }
}

const envLayer = Env.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				MAPLE_ENVIRONMENT: "test",
				TINYBIRD_HOST: "https://api.tinybird.co",
				TINYBIRD_TOKEN: "test-token",
				MAPLE_ROOT_PASSWORD: "test-root-password",
				MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
				MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			}),
		),
	),
)

const budgetWith = (limit: Layer.Layer<DataSourceDevelopmentCallLimit> | Layer.Layer<never>) =>
	DataSourceCallBudgetLive.pipe(Layer.provide(Layer.merge(limit, envLayer)))

describe("DataSourceCallBudgetLive", () => {
	it.effect("takes one unit per call and refuses once the binding says no", () => {
		const { seen, layer } = binding(5)
		return Effect.gen(function* () {
			const budget = yield* DataSourceCallBudget
			yield* budget.spend(SOURCE, 3)
			const error = yield* Effect.flip(budget.spend(SOURCE, 3))
			expect(error).toMatchObject({ _tag: "@maple/data-sources/RateLimited", retryAfterSeconds: 10 })
			expect(seen).toHaveLength(6)
			expect(new Set(seen)).toEqual(new Set([`test:ds:${SOURCE.id}`]))
		}).pipe(Effect.provide(budgetWith(layer)))
	})

	it.effect("lets calls through without the binding, where a binding would refuse them", () =>
		Effect.gen(function* () {
			const spend = Effect.flatMap(DataSourceCallBudget, (budget) =>
				Effect.exit(budget.spend(SOURCE, 1_000)),
			)
			const unbound = yield* spend.pipe(Effect.provide(budgetWith(Layer.empty)))
			const bound = yield* spend.pipe(Effect.provide(budgetWith(binding(5).layer)))
			expect([unbound._tag, bound._tag]).toEqual(["Success", "Failure"])
		}),
	)
})
