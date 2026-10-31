import { CodeReviewTeamMember } from "@maple/domain/http"
import { describe, expect, test } from "vitest"
import { highlightsOf, metricOf, scorecardRows, teamMedian } from "./derive"

const member = (login: string, counts: Partial<CodeReviewTeamMember> = {}) =>
	new CodeReviewTeamMember({
		login,
		pullRequests: 0,
		mergedPullRequests: 0,
		medianMergeSeconds: null,
		findings: 0,
		criticalFindings: 0,
		resolvedFindings: 0,
		openAtMergeFindings: 0,
		shippedClean: 0,
		shippedRegressed: 0,
		ciRuns: 0,
		firstTryRuns: 0,
		firstTryGreen: 0,
		reruns: 0,
		cancelledRuns: 0,
		runnerMs: 0,
		...counts,
	})

const ada = member("ada", {
	pullRequests: 8,
	mergedPullRequests: 6,
	medianMergeSeconds: 7_200,
	resolvedFindings: 9,
	openAtMergeFindings: 1,
	firstTryRuns: 20,
	firstTryGreen: 19,
})
const lin = member("Lin", {
	pullRequests: 6,
	mergedPullRequests: 4,
	medianMergeSeconds: 3_600,
	resolvedFindings: 3,
	openAtMergeFindings: 3,
	firstTryRuns: 12,
	firstTryGreen: 9,
})
const sam = member("sam", { pullRequests: 2, resolvedFindings: 4 })
const ci = member("bea", { ciRuns: 4, firstTryRuns: 3, firstTryGreen: 3 })
const team = [ada, lin, sam, ci]

const logins = (rows: ReturnType<typeof scorecardRows>) => rows.map((row) => row.member.login)

describe("metricOf", () => {
	test("fix rate counts findings fixed against the ones that shipped open", () => {
		expect(metricOf(ada, "fixRate")).toBe(0.9)
		expect(metricOf(lin, "fixRate")).toBe(0.5)
	})

	test("a column with nothing to measure is null, not zero", () => {
		expect(metricOf(ci, "fixRate")).toBeNull()
		expect(metricOf(sam, "firstTryGreen")).toBeNull()
		expect(metricOf(sam, "ciTime")).toBeNull()
	})
})

describe("teamMedian", () => {
	test("is the middle person over the people the column measures", () => {
		expect(teamMedian(team, "mergeTime")).toBe(5_400)
		expect(teamMedian(team, "fixRate")).toBe(0.9)
	})
})

describe("scorecardRows", () => {
	test("unranked by person: everyone, by login whatever the case", () => {
		const rows = scorecardRows(team, "person", false)
		expect(logins(rows)).toEqual(["ada", "bea", "Lin", "sam"])
		expect(rows.every((row) => row.rank === null)).toBe(true)
	})

	test("a column reads best first: fastest merge first, unmeasured people last", () => {
		expect(logins(scorecardRows(team, "mergeTime", false))).toEqual(["Lin", "ada", "bea", "sam"])
		expect(logins(scorecardRows(team, "firstTryGreen", false))).toEqual(["bea", "ada", "Lin", "sam"])
	})

	test("ranked leaves out people under five pull requests and numbers the rest", () => {
		const rows = scorecardRows(team, "fixRate", true)
		expect(rows.map((row) => [row.member.login, row.rank])).toEqual([
			["ada", 1],
			["Lin", 2],
		])
	})

	test("ranked never orders by a count: merged pull requests falls back to the fix rate", () => {
		expect(logins(scorecardRows(team, "merged", true))).toEqual(["ada", "Lin"])
	})

	test("equal values share a rank", () => {
		const twin = member("zed", { pullRequests: 5, resolvedFindings: 9, openAtMergeFindings: 1 })
		const rows = scorecardRows([lin, ada, twin], "fixRate", true)
		expect(rows.map((row) => [row.member.login, row.rank])).toEqual([
			["ada", 1],
			["zed", 1],
			["Lin", 3],
		])
	})
})

describe("highlightsOf", () => {
	test("calls out who fixed most, the steadiest CI and the quickest merge, each with enough to judge", () => {
		expect(highlightsOf(team).map((item) => [item.key, item.login, item.value])).toEqual([
			["fixed", "ada", 9],
			["steady", "ada", 0.95],
			["fast", "Lin", 3_600],
		])
	})

	test("a team of one has nothing to compare", () => {
		expect(highlightsOf([ada])).toEqual([])
	})
})
