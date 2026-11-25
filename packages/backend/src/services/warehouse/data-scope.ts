import { escapeClickHouseString } from "@maple-dev/effect-orm/sql"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Context, Option } from "effect"

// How a namespace-limited role's reads are kept to its namespaces in the warehouse
// (`docs/custom-roles.md`). A datasource that is not listed here cannot be read by one at all.

/**
 * The data scope of the request in progress, set by the auth layers. It holds for every warehouse
 * read the request makes, whichever tenant the read is made as.
 */
export class CurrentDataScope extends Context.Reference<Policy.DataScope>(
	"@maple/backend/services/warehouse/CurrentDataScope",
	{ defaultValue: () => Policy.ALL_DATA },
) {}

// How a datasource is kept to a namespace: by its own `ServiceNamespace` column, by the
// `service.namespace` of the row's resource attributes, or not at all for a `locator`, which says
// where a trace's spans live (ids and time buckets) and is read only by queries Maple wrote.
type ScopeColumn = "namespace" | "resource" | "locator"

const column = (kind: ScopeColumn, names: ReadonlyArray<string>) =>
	Arr.map(names, (name) => [name, kind] as const)

/**
 * Every datasource a namespace-limited role may read. Adding one is a decision: every row must
 * carry its own namespace. A service name is not enough: two namespaces can share one, and whoever
 * can send telemetry can claim one.
 */
export const SCOPED_DATASOURCES: ReadonlyMap<string, ScopeColumn> = new Map([
	...column("namespace", [
		"logs_aggregates_hourly",
		"service_overview_hourly",
		"service_overview_minutely",
		"service_overview_spans",
		"trace_facets_hourly",
		"trace_list_mv",
		"user_activity_daily",
		"user_activity_hourly",
	]),
	...column("resource", [
		"logs",
		"metrics_exponential_histogram",
		"metrics_gauge",
		"metrics_histogram",
		"metrics_sum",
		"profiles",
		"traces",
	]),
	...column("locator", ["trace_index"]),
])

const NAMESPACE_SQL = {
	namespace: "ServiceNamespace",
	resource: "ResourceAttributes['service.namespace']",
} as const

/** Which statement a row filter is for: one Maple compiled, or SQL the caller wrote. */
export type ScopedRead = "compiled" | "caller-sql"

/**
 * The condition that keeps `datasource` to `namespaces`. `None` when it cannot be kept to them: a
 * limited role must not read it. Only values `Policy.isScopeValue` accepts are written, escaped.
 */
export const rowFilterFor = (
	datasource: string,
	namespaces: ReadonlyArray<string>,
	read: ScopedRead,
): Option.Option<string> => {
	const kind = SCOPED_DATASOURCES.get(datasource)
	if (kind === undefined) return Option.none()
	// A locator's rows are never the answer of a compiled read; caller SQL could select them.
	if (kind === "locator") return read === "compiled" ? Option.some("1 = 1") : Option.none()
	const values = Arr.filter(namespaces, Policy.isScopeValue)
	// `IN ()` is not SQL; no namespace at all reads no row.
	if (values.length === 0) return Option.some("1 = 0")
	const literals = Arr.map(values, (value) => `'${escapeClickHouseString(value)}'`)
	return Option.some(`${NAMESPACE_SQL[kind]} IN (${Arr.join(literals, ", ")})`)
}
