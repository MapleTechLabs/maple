import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/domain/primitives"

/**
 * A sub-org whose billing rolls up to another org. The sub-org keeps its own data; its usage,
 * plan and invoice are the billing org's. One level deep: a billing org is never itself linked.
 */
export const OrgBillingLinks = PG.table("org_billing_links", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		billingOrgId: PG.column(PG.brand(PG.text, OrgId), { name: "billing_org_id" }),
		linkedBy: PG.column(PG.brand(PG.text, UserId), { name: "linked_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
	indexes: [PG.index("org_billing_links_billing_org_idx", ["billingOrgId"])],
})

export type OrgBillingLinkRow = PG.SelectRowOf<typeof OrgBillingLinks>
