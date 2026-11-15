import * as PG from "@maple-dev/effect-orm/postgres"
import { SavedViewState, SavedViewSurface, SavedViewVisibility } from "@maple/domain/saved-views"
import { OrgId, SavedViewId, UserId } from "@maple/primitives"

// A named snapshot of one explorer's URL search params (logs, traces or metrics). Private to its
// owner until shared, then listed for the whole org; only the owner changes it.
export const SavedViews = PG.table("saved_views", {
	columns: {
		id: PG.brand(PG.text, SavedViewId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		ownerUserId: PG.column(PG.brand(PG.text, UserId), { name: "owner_user_id" }),
		surface: PG.brand(PG.text, SavedViewSurface),
		name: PG.text,
		state: PG.jsonb(SavedViewState),
		visibility: PG.brand(PG.text, SavedViewVisibility),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: { columns: ["orgId", "id"], name: "saved_views_org_id_id_pk" },
	indexes: [
		// A person's views in one explorer are told apart by name, so a name is theirs once.
		PG.uniqueIndex("saved_views_owner_surface_name_unq", ["orgId", "ownerUserId", "surface", "name"]),
		// The list read: an explorer's views in the org, the caller's own and the shared ones.
		PG.index("saved_views_org_surface_idx", ["orgId", "surface", "visibility"]),
	],
	tenantColumn: "orgId",
})

export type SavedViewRow = PG.SelectRowOf<typeof SavedViews>
