import { Array as Arr, Effect, type Redacted, Schema } from "effect"
import type { ResourceDefinition, ResourceFieldDef, ResourceRow } from "../../resource-engine/types"
import { clerkGet } from "./http"
import { type ParamMapping, serverOpsOf, toParams } from "./params"

export const ClerkOrganizationWire = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	slug: Schema.optionalKey(Schema.NullOr(Schema.String)),
	members_count: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	created_at: Schema.Number,
	updated_at: Schema.Number,
})
export type ClerkOrganizationWire = Schema.Schema.Type<typeof ClerkOrganizationWire>

const OrganizationsPage = Schema.Struct({
	data: Schema.Array(ClerkOrganizationWire),
	total_count: Schema.Number,
})

// The list endpoint has no time filters, so `created_at` filters run in Maple after a sized scan.
const ID_MAPPING: ParamMapping<"organization_id"> = { values: "organization_id" }
const MAPPINGS = new Map([["id", ID_MAPPING]])
const ORDER_BY = new Map([
	["created_at", "created_at"],
	["name", "name"],
	["members_count", "members_count"],
])

export const ORGANIZATION_FIELDS: ReadonlyArray<ResourceFieldDef> = [
	{
		name: "id",
		type: "string",
		capabilities: { filter: "server", sort: false, group: false, measure: true },
		serverOps: serverOpsOf(ID_MAPPING),
	},
	{
		name: "name",
		type: "string",
		capabilities: { filter: "client", sort: true, group: false, measure: false },
		serverOps: [],
	},
	{
		name: "slug",
		type: "string",
		capabilities: { filter: "client", sort: false, group: false, measure: false },
		serverOps: [],
	},
	{
		name: "members_count",
		type: "number",
		capabilities: { filter: "client", sort: true, group: false, measure: true },
		serverOps: [],
	},
	{
		name: "created_at",
		type: "timestamp",
		note: "When the organization was created. Clerk cannot filter on it, so time queries read every organization (fine for a few thousand).",
		capabilities: { filter: "client", sort: true, group: false, measure: true },
		serverOps: [],
	},
	{
		name: "updated_at",
		type: "timestamp",
		capabilities: { filter: "client", sort: false, group: false, measure: false },
		serverOps: [],
	},
]

const orgRow = (org: ClerkOrganizationWire): ResourceRow => ({
	id: org.id,
	name: org.name,
	slug: org.slug ?? null,
	members_count: org.members_count ?? null,
	created_at: org.created_at,
	updated_at: org.updated_at,
})

export const organizationsResource = (secret: Redacted.Redacted): ResourceDefinition => {
	const page = (
		filters: Parameters<ResourceDefinition["fetchPage"]>[0]["filters"],
		extra: ReadonlyArray<readonly ["limit" | "offset" | "order_by", string]>,
	) =>
		Effect.flatMap(toParams(MAPPINGS, filters), (params) =>
			clerkGet(
				secret,
				"/organizations",
				[...params, ["include_members_count", "true"], ...extra],
				OrganizationsPage,
			),
		)
	return {
		name: "organizations",
		note: "Organizations (teams/workspaces) on this Clerk instance, with member counts. Totals are one call; time filters read every organization.",
		noun: { one: "organization", many: "organizations" },
		timeField: "created_at",
		fields: ORGANIZATION_FIELDS,
		pageSize: 500,
		fetchPage: (request) => {
			const order = request.orderBy === null ? undefined : ORDER_BY.get(request.orderBy.field)
			return Effect.map(
				page(request.filters, [
					["limit", String(request.limit)],
					["offset", String(request.offset)],
					...(order === undefined || request.orderBy === null
						? []
						: [["order_by", `${request.orderBy.dir === "desc" ? "-" : "+"}${order}`] as const]),
				]),
				(body) => Arr.map(body.data, orgRow),
			)
		},
		count: (filters) => Effect.map(page(filters, [["limit", "1"]]), (body) => body.total_count),
	}
}
