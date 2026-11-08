/**
 * SLO reads (SlosService) against a populated snapshot, plus the flat scan the rollup splice
 * replaces. Set BENCH_ORG and BENCH_SERVICE to a busy service; windows end at BENCH_END
 * (`YYYY-MM-DD HH:MM:SS`, default now) so the splice edges are partial minutes and hours.
 */
import { Effect, Array as Arr } from "effect"
import * as CH from "@maple/query-engine/ch"
import * as E from "@maple-dev/effect-orm/expr"
import * as Bench from "@maple-dev/effect-orm/benchmark"
import { OrgId } from "@maple/domain"
import type { SloSli } from "@maple/domain/slo"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine/datetime"

const ORG = OrgId.make(process.env.BENCH_ORG ?? "org_sql_catalog")
const SERVICE = process.env.BENCH_SERVICE ?? "api"
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

const END_MS = process.env.BENCH_END ? parseWarehouseDateTime(process.env.BENCH_END) : Date.now()
const window = (spanMs: number) => ({
	orgId: ORG,
	startTime: formatWarehouseDateTime(END_MS - spanMs),
	endTime: formatWarehouseDateTime(END_MS),
})

const AVAILABILITY: SloSli = { _tag: "availability" }
const LATENCY_500: SloSli = { _tag: "latency", thresholdMs: 500 }
const opts = (sli: SloSli) => ({ serviceName: SERVICE, environments: [], sli })

const totals = (id: string, sli: SloSli) =>
	Bench.query({
		id,
		inputs: {
			...window(30 * DAY_MS),
			sli: sli._tag === "latency" ? `latency-${sli.thresholdMs}` : sli._tag,
		},
		compile: ({ orgId, startTime, endTime }) =>
			CH.compile(CH.sloTotalsQuery(opts(sli)), { orgId, startTime, endTime }),
		results: "unordered",
	})

const buckets = (id: string, grain: "hour" | "minute", bucketSeconds: number, spanMs: number) =>
	Bench.query({
		id,
		inputs: { ...window(spanMs), bucketSeconds },
		compile: (inputs) => CH.compile(CH.sloBucketsQuery(opts(AVAILABILITY), grain), inputs),
		results: "ordered",
	})

/** What the splice replaces: one scan of every entry-point span in the window. */
const flatScan = Bench.query({
	id: "baseline/30d/flat-scan-availability",
	inputs: window(30 * DAY_MS),
	compile: (inputs) =>
		CH.compile(
			CH.from(CH.tables.ServiceOverviewSpans)
				.select(($) => ({
					total: E.sum($.SampleRate),
					good: E.sumIf($.SampleRate, $.StatusCode.neq("Error")),
				}))
				.where(($) => [
					$.OrgId.eq(CH.tables.orgIdParam),
					$.ServiceName.eq(SERVICE),
					$.Timestamp.gte(CH.tables.utcSecondsParam("startTime")),
					$.Timestamp.lte(CH.tables.utcSecondsParam("endTime")),
				])
				.format("JSON"),
			inputs,
		),
	results: "unordered",
})

export default Bench.defineSuite({
	name: "slos",
	dataset: process.env.BENCH_DATASET ?? "replace-with-your-snapshot-revision",
	cases: Arr.map(
		[
			totals("totals/30d/availability", AVAILABILITY),
			totals("totals/30d/latency-500ms", LATENCY_500),
			buckets("burn/6h/minute-60s", "minute", 60, 6 * HOUR_MS),
			buckets("history/60d/hour-3600s", "hour", 3600, 60 * DAY_MS),
			flatScan,
		],
		// `defineSuite` takes one error type; a compile failure is a broken suite.
		(sample) => Effect.orDie(sample),
	),
})
