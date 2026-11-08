import type { DataSourceDriver } from "@maple/data-sources"
import { clerkDriver } from "@maple/data-sources/clerk"

/** Every kind this deployment can connect. Each driver PR adds its line here. */
export const DATA_SOURCE_DRIVERS: ReadonlyArray<DataSourceDriver> = [clerkDriver]
