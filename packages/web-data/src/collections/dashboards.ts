import { Schema } from "effect"

/**
 * Raw ElectricSQL row for `dashboards` (snake_case, as it arrives on the shape
 * stream). `payload_json` is the full `DashboardDocument`; `version` is the
 * server CAS token. Collections hold raw rows and map to domain types in
 * selectors — Electric has no row-mapping hook and a transforming schema would
 * split the optimistic write's input/output types.
 *
 * The schema is *identity* (Type === Encoded, no camelCase transform): it exists
 * only to validate the shape stream's row shape so a post-deploy column drift
 * surfaces as a `SchemaValidationError` (→ the collection factory's self-heal),
 * not to reshape the data. Its fields mirror the `dashboards` pgTable exactly.
 * The row-to-`Dashboard` mappers stay in apps/web with the dashboard-builder view model.
 */
export const DashboardRowSchema = Schema.Struct({
	org_id: Schema.String,
	id: Schema.String,
	name: Schema.String,
	payload_json: Schema.Unknown,
	created_at: Schema.String,
	updated_at: Schema.String,
	created_by: Schema.String,
	updated_by: Schema.String,
	version: Schema.Number,
})

export type DashboardRow = typeof DashboardRowSchema.Type
