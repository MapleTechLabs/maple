import * as PG from "@maple-dev/effect-orm/postgres"
import { Slos } from "@maple/db/tables"
import { SloPersistenceError, type WarehouseReadError } from "@maple/domain/http"
import type { AlertRuleId, OrgId } from "@maple/domain/primitives"
import type { SloBurnWindow } from "@maple/domain/slo"
import { Context, Effect, Layer, Option } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { systemTenant } from "@maple/backend/services/alerts/system-tenant"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { readBurnWindows } from "./slo-reads"

export interface SloAlertSourceApi {
	/** The burn windows ending at `endMs` of the SLO that owns `ruleId`; `None` when none does. */
	readonly observe: (
		orgId: OrgId,
		ruleId: AlertRuleId,
		endMs: number,
	) => Effect.Effect<Option.Option<ReadonlyArray<SloBurnWindow>>, SloPersistenceError | WarehouseReadError>
}

const toPersistenceError = (error: unknown) =>
	new SloPersistenceError({
		message: error instanceof Error ? error.message : "SLO persistence failed",
		cause: error,
	})

/**
 * The alert evaluator's view of SLOs: its own service, with only the database and the
 * warehouse, so the alerting worker takes on nothing else of the SLO API.
 */
export class SloAlertSource extends Context.Service<SloAlertSource, SloAlertSourceApi>()(
	"@maple/backend/services/slos/SloAlertSource",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "SloAlertSource", toPersistenceError)
			const warehouse = yield* WarehouseQueryService

			const observe = Effect.fn("SloAlertSource.observe")(function* (
				orgId: OrgId,
				ruleId: AlertRuleId,
				endMs: number,
			) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(Slos)
							.select(
								"id",
								"orgId",
								"serviceName",
								"environmentsJson",
								"sliJson",
								"targetPercent",
								"windowDays",
							)
							.where(($) => [$.orgId.eq(orgId), $.alertRuleId.eq(ruleId)])
							.limit(1),
					),
				)
				const slo = rows[0]
				if (slo === undefined) return Option.none<ReadonlyArray<SloBurnWindow>>()
				yield* Effect.annotateCurrentSpan({ "maple.slo.id": slo.id })
				const windows = yield* readBurnWindows(
					systemTenant(orgId),
					{
						orgId,
						serviceName: slo.serviceName,
						environments: slo.environmentsJson,
						sli: slo.sliJson,
						targetPercent: slo.targetPercent,
						windowDays: slo.windowDays,
					},
					endMs,
				).pipe(Effect.provideService(WarehouseQueryService, warehouse))
				return Option.some(windows)
			})

			return { observe } satisfies SloAlertSourceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
