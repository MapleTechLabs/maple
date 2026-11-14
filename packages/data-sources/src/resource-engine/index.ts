import { Array as Arr, Effect } from "effect"
import {
	type CatalogEntry,
	type CatalogField,
	type DataSourceDriverError,
	DataSourceValidationError,
	type ExternalQuery,
	type SourceCatalog,
} from "@maple/domain/data-sources"
import type { PreparedQuery, QueryRequest } from "../port"
import { executeResourcePlan } from "./execute"
import { planResourceQuery } from "./plan"
import type { ResourceDefinition } from "./types"
import { validateResourceQuery } from "./validate"

export * from "./types"
export { bucketsFor, toIso } from "./time"
export { validateResourceQuery, type ValidatedQuery } from "./validate"
export { planResourceQuery, type ResourcePlan } from "./plan"

/** A declared resource as a catalog entry, notes and capabilities included. */
export const catalogEntryOf = (def: ResourceDefinition): CatalogEntry => ({
	name: def.name,
	kind: "resource",
	note: def.note,
	timeField: def.timeField,
	fields: Arr.map(def.fields, (field): CatalogField => {
		const base = { name: field.name, type: field.type, capabilities: field.capabilities }
		const marked = field.pii === true ? { ...base, pii: true } : base
		return field.note === undefined ? marked : { ...marked, note: field.note }
	}),
})

/** Validates, plans and costs a resource query; the returned `run` makes the calls. */
export const prepareResourceQuery = (
	definitions: ReadonlyArray<ResourceDefinition>,
	query: ExternalQuery,
	request: QueryRequest,
	catalog: SourceCatalog,
): Effect.Effect<PreparedQuery, DataSourceDriverError> =>
	query._tag !== "resource"
		? Effect.fail(
				new DataSourceValidationError({
					message:
						'This source is an API and takes resource queries, not SQL. Example: { "_tag": "resource", "resource": "users", "measure": { "fn": "count" }, "groupBy": { "time": "created_at" } }',
				}),
			)
		: Effect.gen(function* () {
				const validated = yield* validateResourceQuery(definitions, catalog, query, request)
				const planned = yield* planResourceQuery(validated, request)
				return {
					summary: planned.summary,
					run: (context) => executeResourcePlan(validated, planned.plan, request, context),
				}
			})
