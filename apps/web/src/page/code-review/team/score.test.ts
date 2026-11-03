import { CodeReviewTeamMember } from "@maple/domain/http"
import { describe, expect, test } from "vitest"
import { teamScores } from "./score"
import { member } from "./team-member.fixture"
import { Array as Arr } from "effect"

/**
 * Someone with `pullRequests` merged pull requests and every rate at `quality` (0-1): that share of
 * findings fixed, merges shipped clean, first tries green, and the rest as reruns and critical findings.
 */
const steady = (login: string, pullRequests: number, quality: number, mergeSeconds = 3_600) => {
	const findings = pullRequests * 2
	const runs = pullRequests * 3
	return member(login, {
		pullRequests,
		mergedPullRequests: pullRequests,
		medianMergeSeconds: mergeSeconds,
		findings,
		criticalFindings: Math.round(pullRequests * (1 - quality)),
		resolvedFindings: Math.round(findings * quality),
		openAtMergeFindings: findings - Math.round(findings * quality),
		shippedClean: Math.round(pullRequests * quality),
		shippedRegressed: pullRequests - Math.round(pullRequests * quality),
		ciRuns: runs,
		firstTryRuns: runs,
		firstTryGreen: Math.round(runs * quality),
		reruns: Math.round(runs * (1 - quality)),
	})
}

/** A perfect record: everything fixed, clean, green on the first try, a fast merge. */
const flawless = (login: string, pullRequests: number) => steady(login, pullRequests, 1, 600)

/** NaN when missing, so any comparison against it fails. */
const scoreOf = (members: ReadonlyArray<CodeReviewTeamMember>, login: string) =>
	teamScores(members).get(login)?.score ?? Number.NaN

/** A realistic team around the people under test, so no one person sets the team's rates. */
const team = [steady("ada", 14, 0.85), steady("lin", 9, 0.75, 7_200), steady("kai", 11, 0.8, 5_400)]

describe("teamScores", () => {
	test("one flawless pull request does not beat a long, very good record", () => {
		const members = [...team, flawless("newcomer", 1), steady("veteran", 25, 0.9)]
		expect(scoreOf(members, "veteran")).toBeGreaterThan(scoreOf(members, "newcomer"))
	})

	test("six flawless pull requests do not outrank forty-one very good ones", () => {
		const members = [...team, flawless("short", 6), steady("long", 41, 0.85)]
		expect(scoreOf(members, "long")).toBeGreaterThan(scoreOf(members, "short"))
	})

	test("a couple of flawless pull requests do not top the team", () => {
		const members = [...team, flawless("newcomer", 2)]
		const others = Arr.map(team, (m) => scoreOf(members, m.login))
		expect(scoreOf(members, "newcomer")).toBeLessThan(Math.max(...others))
	})

	test("a slightly better record over a fraction of the team's merges does not top those who carry it", () => {
		const members = [steady("light", 40, 0.9), steady("heavy", 150, 0.85), steady("also", 155, 0.83)]
		expect(scoreOf(members, "heavy")).toBeGreaterThan(scoreOf(members, "light"))
	})

	test("splitting the same work into more pull requests gains no more than the volume share", () => {
		// Same findings, regressions and CI runs, cut into four times as many pull requests.
		const whole = steady("whole", 10, 0.8)
		const split = new CodeReviewTeamMember({
			...whole,
			login: "split",
			pullRequests: 40,
			mergedPullRequests: 40,
			shippedClean: whole.shippedClean + 30,
		})
		// In the counts a split reads the same as more work: volume rises to four times the team
		// median, and the per pull request rates thin out. Without PR size that is the price.
		const members = [...team, whole, split]
		expect(scoreOf(members, "split") - scoreOf(members, "whole")).toBeLessThan(14)
	})

	test("someone who never merges has nothing to judge and no score", () => {
		const members = [...team, member("reviewed", { pullRequests: 20, findings: 4, ciRuns: 30 })]
		expect(teamScores(members).has("reviewed")).toBe(false)
	})

	test("a fast merge alone does not outweigh the rest of the record", () => {
		const members = [...team, steady("stamp", 12, 0.75, 30), steady("thorough", 12, 0.85, 5_400)]
		expect(scoreOf(members, "thorough")).toBeGreaterThan(scoreOf(members, "stamp"))
	})

	test("the same record over more pull requests scores higher", () => {
		const members = [...team, steady("few", 3, 0.85), steady("some", 10, 0.85), steady("many", 30, 0.85)]
		expect(scoreOf(members, "some")).toBeGreaterThan(scoreOf(members, "few"))
		expect(scoreOf(members, "many")).toBeGreaterThan(scoreOf(members, "some"))
	})

	test("volume does not buy the score: many sloppy pull requests lose to fewer careful ones", () => {
		const members = [...team, steady("grinder", 40, 0.35, 86_400), steady("careful", 10, 0.95, 3_600)]
		expect(scoreOf(members, "careful")).toBeGreaterThan(scoreOf(members, "grinder"))
	})

	test("with a solid record behind both, the better record wins", () => {
		const members = [...team, steady("good", 15, 0.8), steady("better", 15, 0.95)]
		expect(scoreOf(members, "better")).toBeGreaterThan(scoreOf(members, "good"))
	})

	const base = steady("base", 12, 0.7)
	test.each<[string, Partial<CodeReviewTeamMember>]>([
		[
			"fix rate",
			{
				resolvedFindings: base.resolvedFindings + 4,
				openAtMergeFindings: base.openAtMergeFindings - 4,
			},
		],
		["critical findings", { criticalFindings: 0 }],
		["first-try green", { firstTryGreen: base.firstTryRuns }],
	])("better %s raises the quality", (_column, change) => {
		const before = teamScores([...team, base]).get("base")?.quality ?? Number.NaN
		const improved = new CodeReviewTeamMember({ ...base, ...change })
		expect(teamScores([...team, improved]).get("base")?.quality).toBeGreaterThan(before)
	})

	test.each<[string, Partial<CodeReviewTeamMember>]>([
		// Judged per deploy and service, so a quiet service reads clean whoever ships to it.
		[
			"shipped clean",
			{ shippedClean: base.shippedClean + 2, shippedRegressed: base.shippedRegressed - 2 },
		],
		["reruns", { reruns: 0 }],
		["merge time", { medianMergeSeconds: 600 }],
	])("%s is shown but leaves the quality alone", (_column, change) => {
		const before = teamScores([...team, base]).get("base")?.quality
		const changed = new CodeReviewTeamMember({ ...base, ...change })
		expect(teamScores([...team, changed]).get("base")?.quality).toBe(before)
	})

	test("no CI evidence reads as the team's average, neither punished nor rewarded", () => {
		const reviewsOnly = new CodeReviewTeamMember({
			...steady("reviews-only", 12, 0.8),
			ciRuns: 0,
			firstTryRuns: 0,
			firstTryGreen: 0,
			reruns: 0,
		})
		const members = Arr.map(
			[...team, reviewsOnly, steady("poor-ci", 12, 0.8), steady("great-ci", 12, 0.8)],
			(m) =>
				m.login === "poor-ci"
					? new CodeReviewTeamMember({ ...m, firstTryGreen: 0, reruns: m.ciRuns })
					: m.login === "great-ci"
						? new CodeReviewTeamMember({ ...m, firstTryGreen: m.firstTryRuns, reruns: 0 })
						: m,
		)
		expect(scoreOf(members, "reviews-only")).toBeGreaterThan(scoreOf(members, "poor-ci"))
		expect(scoreOf(members, "reviews-only")).toBeLessThan(scoreOf(members, "great-ci"))
	})

	test("the order people come in does not change anyone's score", () => {
		const members = [...team, flawless("newcomer", 1), steady("veteran", 25, 0.9)]
		expect(new Map(teamScores(members.toReversed()))).toEqual(new Map(teamScores(members)))
	})

	test("people without a score still count toward the team rates others are judged against", () => {
		// Never merged, so unscored, but their critical findings raise the team's rate.
		const careless = member("careless", { pullRequests: 20, findings: 40, criticalFindings: 30 })
		const judged = steady("judged", 12, 0.8)
		expect(scoreOf([...team, judged, careless], "judged")).toBeGreaterThan(
			scoreOf([...team, judged], "judged"),
		)
	})

	test("someone with only CI runs has no score", () => {
		const members = [...team, member("ci-only", { ciRuns: 30, firstTryRuns: 30, firstTryGreen: 30 })]
		expect(teamScores(members).has("ci-only")).toBe(false)
	})
})
