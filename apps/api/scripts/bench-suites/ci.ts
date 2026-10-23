/**
 * The CI page's reads (`ci_runs` / `ci_jobs`) over a week and a month. Edit the org and windows
 * to a populated snapshot; the 2026-10-22 table layout choice was measured on this shape.
 */
import * as CH from "@maple/query-engine/ch"
import * as Bench from "@maple-dev/effect-orm/benchmark"
import { OrgId } from "@maple/domain"

const END = "2026-10-22 22:58:00"
const WINDOWS = { "7d": "2026-10-15 22:58:00", "30d": "2026-09-22 22:58:00" } as const

const cases = (label: keyof typeof WINDOWS) => {
	const inputs = { orgId: OrgId.make("org_sql_catalog"), startTime: WINDOWS[label], endTime: END }
	return [
		Bench.query({
			id: `ci/run-totals/${label}`,
			inputs,
			compile: (i) => CH.compile(CH.ciRunTotalsQuery({}), i),
			results: "unordered",
		}),
		Bench.query({
			id: `ci/run-series/${label}`,
			inputs: { ...inputs, bucketSeconds: 21_600 },
			compile: (i) => CH.compile(CH.ciRunSeriesQuery({}), i),
			results: "unordered",
		}),
		Bench.query({
			id: `ci/pipeline-stats/${label}`,
			inputs,
			compile: (i) => CH.compile(CH.ciPipelineStatsQuery({}), i),
			results: "unordered",
		}),
		Bench.query({
			id: `ci/job-stats/${label}`,
			inputs,
			compile: (i) => CH.compile(CH.ciJobStatsQuery({}), i),
			results: "unordered",
		}),
		Bench.query({
			id: `ci/queue-totals/${label}`,
			inputs,
			compile: (i) => CH.compile(CH.ciQueueTotalsQuery({}), i),
			results: "unordered",
		}),
		Bench.query({
			id: `ci/runs-list/${label}`,
			inputs,
			compile: (i) => CH.compile(CH.ciRunsQuery({ limit: 51 }), i),
			results: "ordered",
		}),
		Bench.query({
			id: `ci/pull-request-runs/${label}`,
			inputs,
			compile: (i) => CH.compile(CH.ciRunsQuery({ pullRequest: 1234, limit: 100 }), i),
			results: "ordered",
		}),
	]
}

export default Bench.defineSuite({
	name: "ci-workload",
	dataset: "replace-with-your-snapshot-revision",
	cases: [...cases("7d"), ...cases("30d")],
})
