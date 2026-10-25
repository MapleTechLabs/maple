/**
 * The service map's span-join tables (`service_map_spans`, `service_map_children`)
 * and their readers, for comparing sort keys on the same exported prod sample.
 * Point CLICKHOUSE_DATABASE at one layout per run; the SQL is identical.
 */
import { Effect } from "effect"
import * as CH from "@maple/query-engine/ch"
import * as Integrations from "@maple/query-engine-integrations/product"
import * as Bench from "@maple-dev/effect-orm/benchmark"
import { OrgId } from "@maple/domain"

const HEAVY = OrgId.make("org_3AuiNCIuD1XCbbzcjkzE3s5HoQj")
const MID = OrgId.make("org_3BfZyFkQay2viWpkkoOS3aVp8nV")
const PAGE: ReadonlyArray<string> = JSON.parse(process.env.SMK_TRACE_PAGE ?? "[]")

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

export default Bench.defineSuite({
	name: "service-map-spans-key",
	dataset: process.env.SMK_DATASET ?? "smap-sample-2026-10-25",
	cases: [
		rollupHour("rollup/heavy/closed-day", HEAVY, "2026-10-24 14:00:00", "2026-10-24 15:00:00"),
		rollupHour("rollup/heavy/current-day", HEAVY, "2026-10-25 10:00:00", "2026-10-25 11:00:00"),
		rollupHour("rollup/mid/current-day", MID, "2026-10-25 10:00:00", "2026-10-25 11:00:00"),
		dependencies("deps/heavy/12h", HEAVY, "2026-10-25 04:50:00", "2026-10-25 16:50:00"),
		dependencies("deps/heavy/24h-across-days", HEAVY, "2026-10-24 16:55:00", "2026-10-25 16:55:00"),
		dependencies("deps/mid/12h", MID, "2026-10-25 04:50:00", "2026-10-25 16:50:00"),
		Bench.query({
			id: "trace-services/heavy/page-50",
			// The page's own span; the runtime used to pad it ±1 day itself.
			inputs: { orgId: HEAVY, startTime: "2026-10-25 17:25:58", endTime: "2026-10-25 17:26:09" },
			compile: (inputs) => CH.compile(CH.traceServicesByTraceIdsQuery({ traceIds: PAGE }), inputs),
			results: "unordered",
		}),
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
	].map((sample) => Effect.orDie(sample)),
})
