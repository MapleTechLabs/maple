import { Effect } from "effect"
import type { WarehouseQueryServiceApi } from "../services/warehouse/WarehouseQueryService"
const die = () => Effect.die("This service is not available in this test harness")
const dieSync = (): never => {
	throw new Error("This service is not available in this test harness")
}
/** Inert WarehouseQueryService for harnesses that never touch warehouse-backed groups. */
export const makeWarehouseServiceStub = (
	overrides: Partial<WarehouseQueryServiceApi> = {},
): WarehouseQueryServiceApi => ({
	query: die,
	crossOrgQuery: die,
	rawSqlQuery: die,
	compiledQuery: die,
	compiledQueryBounded: die,
	compiledQueryWithCapabilities: die,
	compiledQueryFirst: die,
	// Not `die`: warming is best-effort and silent by contract, so a stub that
	// throws would fail a path that only tried to warm up.
	warmRoute: () => Effect.void,
	ingest: die,
	asExecutor: dieSync,
	...overrides,
})
