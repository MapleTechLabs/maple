/**
 * The service map's span-join tables (`service_map_spans`, `service_map_children`)
 * and their readers, for comparing sort keys on the same exported snapshot. Point
 * CLICKHOUSE_DATABASE at one layout per run; the SQL is identical. Set
 * BENCH_ORG_HEAVY / BENCH_ORG_SMALL to the snapshot's orgs and BENCH_TRACE_PAGE to a
 * JSON array of one trace-list page's ids, then edit the windows to match the snapshot.
 */
import { Effect, Schema } from "effect"
import * as CH from "@maple/query-engine/ch"
import * as Integrations from "@maple/query-engine-integrations/product"
import * as Bench from "@maple-dev/effect-orm/benchmark"
import { OrgId } from "@maple/domain"

const HEAVY = OrgId.make(process.env.BENCH_ORG_HEAVY ?? "org_sql_catalog")
const SMALL = OrgId.make(process.env.BENCH_ORG_SMALL ?? "org_sql_catalog")
const PAGE = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
	process.env.BENCH_TRACE_PAGE ?? "[]",
)

const rollupHour = (id: string, orgId: OrgId, hourStart: string, hourEnd: string) =>
	Bench.query({
		id,
		inputs: { orgId, hourStart, hourEnd },
		compile: () => CH.serviceMapEdgesRollupSQL({ orgId, hourStart, hourEnd }),
		results: "unordered",
	})

const dependencies = (id: string, orgId: OrgId, startTime: string, endTime: string) =>
	Bench.query({
		id,
		inputs: { orgId, startTime, endTime },
		compile: () => CH.serviceDependenciesSQL({}, { orgId, startTime, endTime }),
		results: "unordered",
	})

const traceServices = Bench.query({
	id: "trace-services/heavy/page",
	// The page's own span, as the trace list passes it.
	inputs: { orgId: HEAVY, startTime: "2026-10-25 17:25:58", endTime: "2026-10-25 17:26:09" },
	compile: (inputs) => CH.compile(CH.traceServicesByTraceIdsQuery({ traceIds: PAGE }), inputs),
	results: "unordered",
})

export default Bench.defineSuite({
	name: "service-map-spans-key",
	dataset: process.env.BENCH_DATASET ?? "replace-with-your-snapshot-revision",
	cases: [
		rollupHour("rollup/heavy/closed-day", HEAVY, "2026-10-24 14:00:00", "2026-10-24 15:00:00"),
		rollupHour("rollup/heavy/current-day", HEAVY, "2026-10-25 10:00:00", "2026-10-25 11:00:00"),
		rollupHour("rollup/small/current-day", SMALL, "2026-10-25 10:00:00", "2026-10-25 11:00:00"),
		dependencies("deps/heavy/12h", HEAVY, "2026-10-25 04:50:00", "2026-10-25 16:50:00"),
		dependencies("deps/heavy/24h-across-days", HEAVY, "2026-10-24 16:55:00", "2026-10-25 16:55:00"),
		dependencies("deps/small/12h", SMALL, "2026-10-25 04:50:00", "2026-10-25 16:50:00"),
		...(PAGE.length > 0 ? [traceServices] : []),
		Bench.query({
			id: "audit-orphans/heavy/1h",
			inputs: {
				orgId: HEAVY,
				childStart: "2026-10-25 16:00:00",
				childEnd: "2026-10-25 17:00:00",
				parentStart: "2026-10-25 15:00:00",
			},
			compile: (inputs) => Integrations.auditOrphanSpansSQL({ ...inputs, traceSampleModulus: 16 }),
			results: "unordered",
		}),
		// `defineSuite` takes one error type; the CLI compiles before timing, so a
		// compile failure here is a broken suite, not a query result.
	].map((sample) => Effect.orDie(sample)),
})
