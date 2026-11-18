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
 * What Maple may ask of one source per period: its share of an API's own rate limit, or a cap on
 * the queries it sends a SQL source. `unlimited` is for tests.
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
