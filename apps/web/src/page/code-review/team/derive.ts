import type { CodeReviewTeamMember } from "@maple/domain/http"
import type { CodeReviewTeamSearch, CodeReviewTeamSort } from "../../../route/search"
import { medianOf, type Score } from "./score"
import { Array as Arr, String as Str, Order } from "effect"

// The scorecard's numbers from the members' counts: rates, the team median of each, the order, the
// ranked view and the highlights.

/** Ranked view: people with fewer reviewed pull requests than this are left out. */
export const RANK_MIN_PULL_REQUESTS = 5
/** A highlight on first-try CI needs this many judged first attempts. */
const STEADY_CI_MIN_RUNS = 10
/** A highlight on merge time needs this many merged pull requests. */
const FAST_MERGE_MIN_MERGED = 3

export type Metric = Exclude<CodeReviewTeamSort, "person">

/** A bare `/code-review/team` opens ranked by score; the URL only names a different choice. */
export const DEFAULT_SORT: CodeReviewTeamSort = "score"
export const sortOf = (search: typeof CodeReviewTeamSearch.Type): CodeReviewTeamSort =>
	search.sort ?? DEFAULT_SORT
export const isRanked = (search: typeof CodeReviewTeamSearch.Type): boolean => search.ranked ?? true

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole)

export type TeamScores = ReadonlyMap<string, Score>

/** One member's value of a column; null when the member has nothing it is measured over. */
export const metricOf = (member: CodeReviewTeamMember, metric: Metric, scores: TeamScores): number | null => {
	switch (metric) {
		case "score":
			return scores.get(member.login)?.score ?? null
		case "merged":
			return member.mergedPullRequests
		case "mergeTime":
			return member.medianMergeSeconds
		case "fixRate":
			return ratio(member.resolvedFindings, member.resolvedFindings + member.openAtMergeFindings)
		case "criticalPerPr":
			return ratio(member.criticalFindings, member.pullRequests)
		case "firstTryGreen":
			return ratio(member.firstTryGreen, member.firstTryRuns)
		case "rerunRate":
			return ratio(member.reruns, member.ciRuns)
		case "shippedClean":
			return ratio(member.shippedClean, member.shippedClean + member.shippedRegressed)
		case "ciTime":
			return member.ciRuns === 0 ? null : member.runnerMs
	}
}

/** Lower is better for these; the rest read highest first. */
export const ASCENDING: ReadonlySet<Metric> = new Set(["mergeTime", "criticalPerPr", "rerunRate"])

/**
 * Rates, medians and the score only: ranking a count would rank how much someone works, not how.
 * The score weighs volume in, but behind quality and with low counts shrunk to the team.
 */
export const RANKABLE: ReadonlySet<Metric> = new Set([
	"score",
	"mergeTime",
	"fixRate",
	"criticalPerPr",
	"firstTryGreen",
	"rerunRate",
	"shippedClean",
])

/** The team median of a column: the middle person, over the people it measures. */
export const teamMedian = (
	members: ReadonlyArray<CodeReviewTeamMember>,
	metric: Metric,
	scores: TeamScores,
): number | null =>
	medianOf(
		Arr.flatMap(members, (member) => {
			const value = metricOf(member, metric, scores)
			return value === null ? [] : [value]
		}),
	)

export type ScoredRow = Readonly<{ member: CodeReviewTeamMember; rank: number | null }>

const byLogin = (a: CodeReviewTeamMember, b: CodeReviewTeamMember) =>
	Str.localeCompare(b.login, ["en"], { sensitivity: "base" })(a.login)

/** The column a ranked view orders by: a count asked for falls back to the score. */
export const rankedMetric = (sort: CodeReviewTeamSort): Metric =>
	sort !== "person" && RANKABLE.has(sort) ? sort : "score"

/** Ordered by the column (best first, people it does not measure last); ranked numbers them. */
export const scorecardRows = (
	members: ReadonlyArray<CodeReviewTeamMember>,
	sort: CodeReviewTeamSort,
	ranked: boolean,
	/** Over the whole team, so leaving people out of a ranking does not move anyone's score. */
	scores: TeamScores,
): ReadonlyArray<ScoredRow> => {
	const metric: Metric | null = ranked ? rankedMetric(sort) : sort === "person" ? null : sort
	const pool = ranked
		? Arr.filter(members, (member) => member.pullRequests >= RANK_MIN_PULL_REQUESTS)
		: members
	if (metric === null) return Arr.map(Arr.sort(pool, byLogin), (member) => ({ member, rank: null }))
	const ascending = ASCENDING.has(metric)
	const ordered = Arr.sort(pool, (a: CodeReviewTeamMember, b: CodeReviewTeamMember) => {
		const left = metricOf(a, metric, scores)
		const right = metricOf(b, metric, scores)
		if (left === null || right === null) return left === right ? byLogin(a, b) : left === null ? 1 : -1
		if (left === right) return byLogin(a, b)
		return ascending ? Order.Number(left, right) : Order.Number(right, left)
	})
	if (!ranked) return Arr.map(ordered, (member) => ({ member, rank: null }))
	// Equal values share a rank; people the column does not measure get none.
	let rank = 0
	let previous: number | null = null
	return Arr.map(ordered, (member, index) => {
		const value = metricOf(member, metric, scores)
		if (value === null) return { member, rank: null }
		if (value !== previous) rank = index + 1
		previous = value
		return { member, rank }
	})
}

export type Highlight = Readonly<{
	key: "fixed" | "steady" | "fast"
	title: string
	login: string
	/** The number behind it, formatted by the view. */
	value: number
}>

const best = (
	members: ReadonlyArray<CodeReviewTeamMember>,
	valueOf: (member: CodeReviewTeamMember) => number | null,
	lowest: boolean,
): { login: string; value: number } | undefined => {
	const scored = Arr.flatMap(members, (member) => {
		const value = valueOf(member)
		return value === null ? [] : [{ login: member.login, value }]
	})
	type Scored = (typeof scored)[number]
	return Arr.sort(scored, (a: Scored, b: Scored) =>
		a.value === b.value
			? Str.localeCompare(b.login)(a.login)
			: lowest
				? Order.Number(a.value, b.value)
				: Order.Number(b.value, a.value),
	).at(0)
}

/** A few habits worth calling out, never a ranking: a team of one has nothing to compare. */
export const highlightsOf = (members: ReadonlyArray<CodeReviewTeamMember>): ReadonlyArray<Highlight> => {
	if (members.length < 2) return []
	const fixed = best(
		members,
		(member) => (member.resolvedFindings > 0 ? member.resolvedFindings : null),
		false,
	)
	const steady = best(
		members,
		(member) =>
			member.firstTryRuns >= STEADY_CI_MIN_RUNS
				? ratio(member.firstTryGreen, member.firstTryRuns)
				: null,
		false,
	)
	const fast = best(
		members,
		(member) => (member.mergedPullRequests >= FAST_MERGE_MIN_MERGED ? member.medianMergeSeconds : null),
		true,
	)
	return [
		...(fixed === undefined ? [] : [{ key: "fixed" as const, title: "Most findings fixed", ...fixed }]),
		...(steady === undefined ? [] : [{ key: "steady" as const, title: "Steadiest CI", ...steady }]),
		...(fast === undefined ? [] : [{ key: "fast" as const, title: "Quickest to merge", ...fast }]),
	]
}
