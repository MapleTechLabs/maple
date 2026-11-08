import * as PG from "@maple-dev/effect-orm/postgres"
import { OnCallLayers } from "@maple/domain/http"
import { OnCallOverrideId, OnCallScheduleId, OrgId, UserId } from "@maple/domain/primitives"

/** Who is on call when: layered rotations in one time zone. Overrides sit on top. */
export const OnCallSchedules = PG.table("oncall_schedules", {
	columns: {
		id: PG.brand(PG.text, OnCallScheduleId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		description: PG.nullable(PG.text),
		timeZone: PG.column(PG.text, { name: "time_zone" }),
		layersJson: PG.column(PG.jsonb(OnCallLayers), { name: "layers_json" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		createdBy: PG.column(PG.text, { name: "created_by" }),
		updatedBy: PG.column(PG.text, { name: "updated_by" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("oncall_schedules_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

/** One person covering a schedule for a window; the newest overlapping override wins. */
export const OnCallOverrides = PG.table("oncall_overrides", {
	columns: {
		id: PG.brand(PG.text, OnCallOverrideId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		scheduleId: PG.column(PG.brand(PG.text, OnCallScheduleId), { name: "schedule_id" }),
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		startsAt: PG.column(PG.timestamptzMillis, { name: "starts_at" }),
		endsAt: PG.column(PG.timestamptzMillis, { name: "ends_at" }),
		createdBy: PG.column(PG.text, { name: "created_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("oncall_overrides_org_schedule_ends_idx", ["orgId", "scheduleId", "endsAt"])],
	foreignKeys: [
		PG.foreignKey({
			columns: ["scheduleId"],
			references: OnCallSchedules,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type OnCallScheduleRow = PG.SelectRowOf<typeof OnCallSchedules>
export type OnCallOverrideRow = PG.SelectRowOf<typeof OnCallOverrides>
