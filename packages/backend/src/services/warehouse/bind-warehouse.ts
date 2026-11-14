import { Effect } from "effect"
import { WarehouseQueryService, type WarehouseQueryServiceApi } from "./WarehouseQueryService"

/**
 * Bind a read that reaches the warehouse to the instance a read service captured at build, so the
 * service's methods ask their callers for nothing beyond their arguments.
 */
export const bindWarehouse =
	(warehouse: WarehouseQueryServiceApi) =>
	<Args extends ReadonlyArray<unknown>, A, E>(
		read: (...args: Args) => Effect.Effect<A, E, WarehouseQueryService>,
	) =>
	(...args: Args): Effect.Effect<A, E> =>
		read(...args).pipe(Effect.provideService(WarehouseQueryService, warehouse))
