import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/primitives"

/**
 * A cost provider someone asked Maple to support, from the Cost page's Add source dialog. Read by
 * the Maple team to decide which source to build next; nothing in the product acts on it.
 */
export const CostSourceRequests = PG.table("cost_source_requests", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		/** The provider as the person typed it ("Hetzner", "Datadog"). */
		provider: PG.text,
		/** What they would want from it, when they said. */
		note: PG.nullable(PG.text),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("cost_source_requests_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

export type CostSourceRequestRow = PG.SelectRowOf<typeof CostSourceRequests>
