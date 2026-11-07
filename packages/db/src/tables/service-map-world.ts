import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

// The org's 3D service map world, one row per entity (`kind` is its `_tag`). `data` is the
// whole entity; readers select it with `PG.undecoded` so an unknown or old kind is skipped.
export const ServiceMapWorldEntities = PG.table("service_map_world_entities", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		entityId: PG.column(PG.text, { name: "entity_id" }),
		kind: PG.column(PG.text, { name: "kind" }),
		data: PG.column(PG.jsonb(Schema.Record(Schema.String, Schema.Unknown)), { name: "data" }),
		revision: PG.column(PG.int4, { name: "revision" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "updated_by" }),
	},
	primaryKey: ["orgId", "entityId"],
	tenantColumn: "orgId",
})

export type ServiceMapWorldEntityRow = PG.SelectRowOf<typeof ServiceMapWorldEntities>
