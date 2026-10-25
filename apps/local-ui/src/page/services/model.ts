import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import { Copies } from "../kit/copies"
import { Draft } from "../traces/model"

// The service catalog, as Schemas.

export const ServiceCatalogEntry = Schema.Struct({
	serviceName: Schema.String,
	serviceNamespaces: Schema.Array(Schema.String),
	deploymentEnvironments: Schema.Array(Schema.String),
	spanCount: Schema.Number,
	errorCount: Schema.Number,
	errorRate: Schema.Number,
	p50LatencyMs: Schema.Number,
	p95LatencyMs: Schema.Number,
	p99LatencyMs: Schema.Number,
	/** Log volume from the usage rollup (0 when the service has none). */
	logCount: Schema.Number,
})
export type ServiceCatalogEntry = typeof ServiceCatalogEntry.Type

export const Catalog = Schema.Array(ServiceCatalogEntry)
export type Catalog = typeof Catalog.Type

export const Model = Schema.TaggedStruct("ServicesPage", {
	/** The time window's anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	nowMs: Schema.Number,
	/** The env/ns-filtered catalog (the rows). */
	catalog: SlotSchema(Catalog),
	/** The unfiltered catalog (the facets); unused while no filter is set, as both keys are one. */
	unfiltered: SlotSchema(Catalog),
	/** `dataUpdatedAt` of the rows, for the "New data" pill. */
	catalogUpdatedAtMs: Schema.Number,
	search: Draft,
	sections: FilterSections.Model,
	isRefreshing: Schema.Boolean,
	copies: Copies,
})
export type Model = typeof Model.Type
