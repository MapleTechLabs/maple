import { describe, expect, test } from "vitest"
import { highlightsOf, metricOf, scorecardRows, teamMedian } from "./derive"
import { teamScores } from "./score"
import { member } from "./team-member.fixture"
import { Array as Arr } from "effect"

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

const scores = teamScores(team)

const logins = (rows: ReturnType<typeof scorecardRows>) => Arr.map(rows, (row) => row.member.login)

describe("metricOf", () => {
	test("fix rate counts findings fixed against the ones that shipped open", () => {
		expect(metricOf(ada, "fixRate", scores)).toBe(0.9)
		expect(metricOf(lin, "fixRate", scores)).toBe(0.5)
	})

	test("a column with nothing to measure is null, not zero", () => {
		expect(metricOf(ci, "fixRate", scores)).toBeNull()
		expect(metricOf(sam, "firstTryGreen", scores)).toBeNull()
		expect(metricOf(sam, "ciTime", scores)).toBeNull()
	})
})

describe("teamMedian", () => {
	test("is the middle person over the people the column measures", () => {
		expect(teamMedian(team, "mergeTime", scores)).toBe(5_400)
		expect(teamMedian(team, "fixRate", scores)).toBe(0.9)
	})
})

describe("scorecardRows", () => {
	test("unranked by person: everyone, by login whatever the case", () => {
		const rows = scorecardRows(team, "person", false, scores)
		expect(logins(rows)).toEqual(["ada", "bea", "Lin", "sam"])
		expect(Arr.every(rows, (row) => row.rank === null)).toBe(true)
	})

	test("a column reads best first: fastest merge first, unmeasured people last", () => {
		expect(logins(scorecardRows(team, "mergeTime", false, scores))).toEqual(["Lin", "ada", "bea", "sam"])
		expect(logins(scorecardRows(team, "firstTryGreen", false, scores))).toEqual([
			"bea",
			"ada",
			"Lin",
			"sam",
		])
	})

	test("ranked leaves out people under five pull requests and numbers the rest", () => {
		const rows = scorecardRows(team, "fixRate", true, scores)
		expect(Arr.map(rows, (row) => [row.member.login, row.rank])).toEqual([
			["ada", 1],
			["Lin", 2],
		])
	})

	test("ranked never orders by a count: merged pull requests falls back to the score", () => {
		expect(logins(scorecardRows(team, "merged", true, scores))).toEqual(["ada", "Lin"])
	})

	test("by score: best first, people with no merged pull request last", () => {
		expect(logins(scorecardRows(team, "score", false, scores))).toEqual(["ada", "Lin", "bea", "sam"])
	})

	test("equal values share a rank", () => {
		const twin = member("zed", { pullRequests: 5, resolvedFindings: 9, openAtMergeFindings: 1 })
		const rows = scorecardRows([lin, ada, twin], "fixRate", true, teamScores([lin, ada, twin]))
		expect(Arr.map(rows, (row) => [row.member.login, row.rank])).toEqual([
			["ada", 1],
			["zed", 1],
			["Lin", 3],
		])
	})
})

describe("highlightsOf", () => {
	test("calls out who fixed most, the steadiest CI and the quickest merge, each with enough to judge", () => {
		expect(Arr.map(highlightsOf(team), (item) => [item.key, item.login, item.value])).toEqual([
			["fixed", "ada", 9],
			["steady", "ada", 0.95],
			["fast", "Lin", 3_600],
		])
	})

	test("a team of one has nothing to compare", () => {
		expect(highlightsOf([ada])).toEqual([])
	})
})
