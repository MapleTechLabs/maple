import { Context, Effect, Layer } from "effect"
import { bindWarehouse } from "@maple/backend/services/warehouse/bind-warehouse"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	readBudgetHistory,
	readBurnBatch,
	readBurnWindows,
	readStatuses,
	readTotalsBatch,
	readWindowTotals,
} from "./slo-reads"

/** The SLO warehouse reads, shared by the SLO API and the alerting SLO source. */
const make = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService
	const bind = bindWarehouse(warehouse)
	return {
		windowTotals: bind(readWindowTotals),
		burnWindows: bind(readBurnWindows),
		budgetHistory: bind(readBudgetHistory),
		statuses: bind(readStatuses),
		burnBatch: bind(readBurnBatch),
		totalsBatch: bind(readTotalsBatch),
	}
})

export class SloReadService extends Context.Service<SloReadService>()(
	"@maple/backend/services/slos/SloReadService",
	{
		make,
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
