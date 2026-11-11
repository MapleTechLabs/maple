import { toEpochMs } from "@maple/ui/lib/time-format"
import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { VERCEL_BUCKETS, VERCEL_TEAM_DEPLOYMENTS } from "../../../lab/vercel-infra-fixtures"
import { teamDeploySignals } from "./overview-model"

const BUCKET_MS = 15 * 60_000
const startMs = toEpochMs(VERCEL_BUCKETS[0]?.bucket ?? "")
const endMs = toEpochMs(VERCEL_BUCKETS[VERCEL_BUCKETS.length - 1]?.bucket ?? "") + BUCKET_MS

describe("teamDeploySignals", () => {
	it("bands the deploy before the team's 5xx spike and labels every deploy with its project and commit", () => {
		const names = new Map([
			["prj_api", "api"],
			["prj_storefront", "storefront"],
		])
		const { markers, commits, regressions } = teamDeploySignals({
			deployments: VERCEL_TEAM_DEPLOYMENTS,
			buckets: VERCEL_BUCKETS,
			window: { startMs, endMs },
			bucketMs: BUCKET_MS,
			projectName: (id) => names.get(id) ?? id,
		})
		expect(Arr.map(regressions, (r) => r.deployment.id)).toEqual(["api-z3"])
		expect(Arr.map(markers, (m) => [m.id, m.tone])).toEqual([["api-z3", "crit"]])
		expect(Arr.map(commits, (c) => c.label)).toEqual([
			"api · Cache product prices at the edge",
			"api · Revert: cache product prices at the edge",
			expect.stringMatching(/^storefront · /),
		])
	})
})
