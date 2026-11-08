import type { DataSourceDriver } from "@maple/data-sources"
import type {
	DataSourceKind,
	DataSourceRateLimitedError,
	ExternalDataSourceId,
	DataSourceConfig,
} from "@maple/domain/data-sources"
import { Array as Arr, Context, Effect, Layer } from "effect"

/** The drivers this deployment serves, one per kind. The app root provides them. */
export class DataSourceDrivers extends Context.Service<
	DataSourceDrivers,
	ReadonlyMap<DataSourceKind, DataSourceDriver>
>()("@maple/backend/services/data-sources/DataSourceDrivers") {
	static readonly fromList = (drivers: ReadonlyArray<DataSourceDriver>) =>
		Layer.succeed(this, new Map(Arr.map(drivers, (driver) => [driver.kind, driver] as const)))
}

export interface BudgetedSource {
	readonly id: ExternalDataSourceId
	readonly config: DataSourceConfig
}

/**
 * Maple's share of a source's own rate limit. Absent means unlimited, which is right for
 * SQL sources (their limits are concurrency, not request rate) and for tests.
 */
export class DataSourceCallBudget extends Context.Service<
	DataSourceCallBudget,
	{
		readonly spend: (
			source: BudgetedSource,
			calls: number,
		) => Effect.Effect<void, DataSourceRateLimitedError>
	}
>()("@maple/backend/services/data-sources/DataSourceCallBudget") {
	static readonly unlimited = Layer.succeed(this, { spend: () => Effect.void })
}
