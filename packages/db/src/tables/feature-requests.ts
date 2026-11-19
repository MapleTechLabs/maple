import * as PG from "@maple-dev/effect-orm/postgres"
import { FeatureRequestArea } from "@maple/domain/feature-requests"
import { OrgId, UserId } from "@maple/primitives"

/**
 * Something a member asked Maple to support, from wherever the app offers to ask (a cost provider
 * from the Cost page's Add source dialog). Read by the Maple team to decide what to build next;
 * nothing in the product acts on it.
 */
export const FeatureRequests = PG.table("feature_requests", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		/** Where it was asked, which says what `subject` names. */
		area: PG.brand(PG.text, FeatureRequestArea),
		/** What they asked for, as they typed it ("Hetzner"). */
		subject: PG.text,
		/** Why they want it, when they said. */
		note: PG.nullable(PG.text),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("feature_requests_org_idx", ["orgId"]),
		PG.index("feature_requests_area_created_idx", ["area", "createdAt"]),
	],
	tenantColumn: "orgId",
})

export type FeatureRequestRow = PG.SelectRowOf<typeof FeatureRequests>
