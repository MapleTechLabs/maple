import { describe, expect, it } from "@effect/vitest"
import { ExternalDataSourceId } from "@maple/domain/data-sources"
import { Array as Arr, ConfigProvider, Effect, Layer, Logger, Schema } from "effect"
import { DataSourceDevelopmentCallLimit, DataSourceSqlQueryLimit } from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"
import { DataSourceCallBudgetLive } from "./DataSourceCallBudgetLive"
import { DataSourceCallBudget } from "./DataSourceDrivers"

const SOURCE = {
	id: Schema.decodeSync(ExternalDataSourceId)("00000000-0000-4000-8000-000000000002"),
	config: { _tag: "clerk", instance: "development" },
} as const

const SQL_SOURCE = {
	id: Schema.decodeSync(ExternalDataSourceId)("00000000-0000-4000-8000-000000000003"),
	config: { _tag: "clickhouse", url: "https://ch.example.com:8443", user: "reader", database: "shop" },
} as const
const OTHER_SQL_SOURCE = {
	...SQL_SOURCE,
	id: Schema.decodeSync(ExternalDataSourceId)("00000000-0000-4000-8000-000000000004"),
}

/** A SQL query binding that allows `allowed` queries per key, counting every `limit()` it sees. */
const sqlBinding = (allowed: number) => {
	const seen: Array<string> = []
	const layer = Layer.succeed(DataSourceSqlQueryLimit, {
		limit: (key: string) =>
			Effect.sync(() => {
				seen.push(key)
				return { success: Arr.filter(seen, (other) => other === key).length <= allowed }
			}),
	})
	return { seen, layer }
}

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

const budgetWith = (
	limit:
		| Layer.Layer<DataSourceDevelopmentCallLimit>
		| Layer.Layer<DataSourceSqlQueryLimit>
		| Layer.Layer<never>,
) => DataSourceCallBudgetLive.pipe(Layer.provide(Layer.merge(limit, envLayer)))

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

	it.effect("caps the queries sent to one SQL source, each source on its own count", () => {
		const { seen, layer } = sqlBinding(2)
		return Effect.gen(function* () {
			const budget = yield* DataSourceCallBudget
			yield* budget.spend(SQL_SOURCE, 1)
			yield* budget.spend(SQL_SOURCE, 1)
			const error = yield* Effect.flip(budget.spend(SQL_SOURCE, 1))
			expect(error).toMatchObject({
				_tag: "@maple/data-sources/RateLimited",
				retryAfterSeconds: 60,
				limitedBy: "maple",
			})
			expect(error.message).toContain("Maple's own limit")
			// Another source is not held to the first one's count.
			yield* budget.spend(OTHER_SQL_SOURCE, 1)
			expect(seen).toEqual([
				...Arr.replicate(`test:ds:${SQL_SOURCE.id}`, 3),
				`test:ds:${OTHER_SQL_SOURCE.id}`,
			])
		}).pipe(Effect.provide(budgetWith(layer)))
	})

	it.effect("lets SQL queries through without the binding, as it does API calls", () =>
		Effect.gen(function* () {
			const spend = Effect.flatMap(DataSourceCallBudget, (budget) =>
				Effect.exit(Effect.forEach(Arr.range(1, 5), () => budget.spend(SQL_SOURCE, 1))),
			)
			const unbound = yield* spend.pipe(Effect.provide(budgetWith(Layer.empty)))
			const bound = yield* spend.pipe(Effect.provide(budgetWith(sqlBinding(2).layer)))
			expect([unbound._tag, bound._tag]).toEqual(["Success", "Failure"])
		}),
	)

	it.effect("warns once that it is failing open when the binding is missing", () => {
		const warnings: Array<string> = []
		const captureLogs = Logger.layer([
			Logger.make(({ message, logLevel }) => {
				if (logLevel === "Warn") warnings.push(String(message))
			}),
		])
		return Effect.gen(function* () {
			const budget = yield* DataSourceCallBudget
			yield* Effect.forEach(Arr.range(1, 4), () => budget.spend(SQL_SOURCE, 2), { discard: true })
			expect(warnings).toEqual(["Data source call budget unavailable; allowing call"])
		}).pipe(Effect.provide(Layer.merge(budgetWith(Layer.empty), captureLogs)))
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
