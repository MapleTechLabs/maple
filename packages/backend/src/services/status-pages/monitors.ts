import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { UptimeMonitors } from "@maple/db/tables"
import { StatusPageValidationError } from "@maple/domain/http"
import { UptimeMonitorPublicId } from "@maple/domain/http/v2"
import type { OrgId, UptimeMonitorId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"

const encodeMonitorId = Schema.encodeSync(UptimeMonitorPublicId)

/** Every monitor must belong to the org; the error names the first that does not by its public id. */
export const ensureMonitorsInOrg = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	monitorIds: ReadonlyArray<UptimeMonitorId>,
) {
	const [first, ...rest] = monitorIds
	if (first === undefined) return
	const found = yield* db.run(
		PG.from(UptimeMonitors)
			.select("id")
			.where(($) => [$.orgId.eq(orgId), $.id.in_(first, ...rest)]),
	)
	const known = new Set(found.map((row) => row.id))
	const missing = monitorIds.find((id) => !known.has(id))
	if (missing !== undefined)
		return yield* new StatusPageValidationError({
			message: `Unknown uptime monitor ${encodeMonitorId(missing)}`,
		})
})
