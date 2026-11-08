import type { DataSourceDriver } from "@maple/data-sources"
import { clickHouseDriver } from "@maple/data-sources/clickhouse"

/** Every kind this deployment can connect. Each driver PR adds its line here. */
export const DATA_SOURCE_DRIVERS: ReadonlyArray<DataSourceDriver> = [clickHouseDriver]
