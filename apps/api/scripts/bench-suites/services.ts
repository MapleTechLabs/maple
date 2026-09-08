/** Edit the inputs to a representative fixed window in a populated snapshot. */
import * as CH from "@maple/query-engine/ch"
import * as Bench from "@maple-dev/clickhouse-builder/benchmark"

export default Bench.defineSuite({
	name: "services-workload",
	dataset: "replace-with-your-snapshot-revision",
	cases: [
		Bench.query({
			id: "services/facets/partial-hours",
			inputs: {
				orgId: "org_sql_catalog",
				startTime: "2026-01-01 10:30:00",
				endTime: "2026-01-03 14:15:00",
			},
			compile: (inputs) => CH.compileUnion(CH.servicesFacetsQuery(), inputs),
			results: "unordered",
		}),
	],
})
