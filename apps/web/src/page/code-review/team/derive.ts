import type { CodeReviewTeamMember } from "@maple/domain/http"
import type { CodeReviewTeamSort } from "../../../route/search"

// The scorecard's numbers from the members' counts: rates, the team median of each, the order, the
// ranked view and the highlights.

/** Ranked view: people with fewer reviewed pull requests than this are left out. */
export const RANK_MIN_PULL_REQUESTS = 5
/** A highlight on first-try CI needs this many judged first attempts. */
const STEADY_CI_MIN_RUNS = 10
/** A highlight on merge time needs this many merged pull requests. */
const FAST_MERGE_MIN_MERGED = 3

export type Metric = Exclude<CodeReviewTeamSort, "person">

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole)

/** One member's value of a column; null when the member has nothing it is measured over. */
export const metricOf = (member: CodeReviewTeamMember, metric: Metric): number | null => {
	switch (metric) {
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

/** Rates and medians only: ranking a count would rank how much someone works, not how. */
export const RANKABLE: ReadonlySet<Metric> = new Set([
	"mergeTime",
	"fixRate",
	"criticalPerPr",
	"firstTryGreen",
	"rerunRate",
	"shippedClean",
])

const medianOf = (values: ReadonlyArray<number>): number | null => {
	if (values.length === 0) return null
	const sorted = values.toSorted((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** The team median of a column: the middle person, over the people it measures. */
export const teamMedian = (members: ReadonlyArray<CodeReviewTeamMember>, metric: Metric): number | null =>
	medianOf(
		members.flatMap((member) => {
			const value = metricOf(member, metric)
			return value === null ? [] : [value]
		}),
	)

export type ScoredRow = Readonly<{ member: CodeReviewTeamMember; rank: number | null }>

const byLogin = (a: CodeReviewTeamMember, b: CodeReviewTeamMember) =>
	a.login.localeCompare(b.login, "en", { sensitivity: "base" })

/** The column a ranked view orders by: a count asked for falls back to the fix rate. */
export const rankedMetric = (sort: CodeReviewTeamSort): Metric =>
	sort !== "person" && RANKABLE.has(sort) ? sort : "fixRate"

/** Ordered by the column (best first, people it does not measure last); ranked numbers them. */
export const scorecardRows = (
	members: ReadonlyArray<CodeReviewTeamMember>,
	sort: CodeReviewTeamSort,
	ranked: boolean,
): ReadonlyArray<ScoredRow> => {
	const metric: Metric | null = ranked ? rankedMetric(sort) : sort === "person" ? null : sort
	const pool = ranked ? members.filter((member) => member.pullRequests >= RANK_MIN_PULL_REQUESTS) : members
	if (metric === null) return pool.toSorted(byLogin).map((member) => ({ member, rank: null }))
	const direction = ASCENDING.has(metric) ? 1 : -1
	const ordered = pool.toSorted((a, b) => {
		const left = metricOf(a, metric)
		const right = metricOf(b, metric)
		if (left === null || right === null) return left === right ? byLogin(a, b) : left === null ? 1 : -1
		return left === right ? byLogin(a, b) : (left - right) * direction
	})
	if (!ranked) return ordered.map((member) => ({ member, rank: null }))
	// Equal values share a rank; people the column does not measure get none.
	let rank = 0
	let previous: number | null = null
	return ordered.map((member, index) => {
		const value = metricOf(member, metric)
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
	const scored = members.flatMap((member) => {
		const value = valueOf(member)
		return value === null ? [] : [{ login: member.login, value }]
	})
	return scored
		.toSorted((a, b) =>
			a.value === b.value ? a.login.localeCompare(b.login) : (a.value - b.value) * (lowest ? 1 : -1),
		)
		.at(0)
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
		(member) => (member.firstTryRuns >= STEADY_CI_MIN_RUNS ? metricOf(member, "firstTryGreen") : null),
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
