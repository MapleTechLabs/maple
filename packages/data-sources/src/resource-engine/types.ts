import type { Effect } from "effect"
import type { HttpClient } from "effect/http"
import type {
	CatalogFieldCapabilities,
	CatalogFieldType,
	DataSourceDriverError,
	ResourceFilterOp,
	ResourceScalar,
} from "@maple/domain/data-sources"

/** One value of a fetched row; timestamps are epoch ms until the result renders them. */
export type ResourceCell = ResourceScalar | null

/** One fetched row, flattened by the driver to the declared field names. */
export type ResourceRow = Readonly<Record<string, ResourceCell>>

/** A filter after validation: `within_window` is expanded to `gte` + `lt`, timestamps are epoch ms. */
export interface ResolvedFilter {
	readonly field: string
	readonly op: Exclude<ResourceFilterOp, "within_window">
	readonly value: ResourceScalar | ReadonlyArray<ResourceScalar>
}

export type ServerFilterOp = ResolvedFilter["op"]

export interface ResourceFieldDef {
	readonly name: string
	readonly type: CatalogFieldType
	readonly capabilities: CatalogFieldCapabilities
	/** Ops the API applies itself; any other op on a `server` field runs client side. */
	readonly serverOps: ReadonlyArray<ServerFilterOp>
	readonly pii?: boolean
	readonly note?: string
	/** Holds only the latest value per row, so a history over it would silently undercount. */
	readonly latestOnly?: boolean
	/** Usable in filters only; rows do not carry it. */
	readonly filterOnly?: boolean
}

export interface PageRequest {
	/** Only the filters the API applies (every op is in the field's `serverOps`). */
	readonly filters: ReadonlyArray<ResolvedFilter>
	readonly orderBy: { readonly field: string; readonly dir: "asc" | "desc" } | null
	readonly limit: number
	readonly offset: number
}

type Fetch<A> = Effect.Effect<A, DataSourceDriverError, HttpClient.HttpClient>

/** An API resource as a driver declares it. Fetchers never see client-side filters. */
export interface ResourceDefinition {
	readonly name: string
	readonly note: string
	/** Singular and plural nouns for plan descriptions and refusals. */
	readonly noun: { readonly one: string; readonly many: string }
	readonly timeField: string
	readonly fields: ReadonlyArray<ResourceFieldDef>
	readonly pageSize: number
	readonly fetchPage: (request: PageRequest) => Fetch<ReadonlyArray<ResourceRow>>
	/** Total rows matching the server filters, in one call. Absent when the API has no total. */
	readonly count?: (filters: ReadonlyArray<ResolvedFilter>) => Fetch<number>
}
