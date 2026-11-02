import type { CodeReviewTeamMember } from "@maple/domain/http"

// One 0-100 score per person from every scorecard column. Each rate is shrunk toward the team's
// pooled rate by a few pseudo-observations, so a perfect run over one or two pull requests reads
// close to average until there is evidence behind it. A smaller share rewards merged volume.

/** Share of the score from quality; the rest is merged volume. */
const QUALITY_SHARE = 0.8
/** Merged pull requests that earn the full volume share; fixed, so one outlier moves nobody else. */
const VOLUME_REFERENCE = 20

type Component = Readonly<{
	weight: number
	/** Pseudo-observations of the team value added to everyone's own. */
	prior: number
}>

const COMPONENTS = {
	fixRate: { weight: 0.3, prior: 15 },
	shippedClean: { weight: 0.25, prior: 10 },
	criticalShare: { weight: 0.15, prior: 10 },
	firstTryGreen: { weight: 0.15, prior: 20 },
	rerunRate: { weight: 0.1, prior: 20 },
	// Light: a fast merge is as often a quick reviewer, or a rubber stamp, as it is good work.
	mergeTime: { weight: 0.05, prior: 3 },
} satisfies Readonly<Record<string, Component>>

type ComponentKey = keyof typeof COMPONENTS
type RateKey = Exclude<ComponentKey, "mergeTime">

const RATE_KEYS: ReadonlyArray<RateKey> = [
	"fixRate",
	"shippedClean",
	"criticalShare",
	"firstTryGreen",
	"rerunRate",
]
const COMPONENT_KEYS: ReadonlyArray<ComponentKey> = [...RATE_KEYS, "mergeTime"]

/** A count over trials, e.g. findings fixed over findings judged. */
type Tally = Readonly<{ hits: number; trials: number }>

const TALLIES = {
	fixRate: (m) => ({ hits: m.resolvedFindings, trials: m.resolvedFindings + m.openAtMergeFindings }),
	shippedClean: (m) => ({ hits: m.shippedClean, trials: m.shippedClean + m.shippedRegressed }),
	// Of the findings, not per pull request: cutting the same work finer does not dilute it.
	criticalShare: (m) => ({ hits: m.criticalFindings, trials: m.findings }),
	firstTryGreen: (m) => ({ hits: m.firstTryGreen, trials: m.firstTryRuns }),
	rerunRate: (m) => ({ hits: m.reruns, trials: m.ciRuns }),
} satisfies Readonly<Record<RateKey, (member: CodeReviewTeamMember) => Tally>>

/** Turns a shrunk rate into goodness in [0, 1], higher better. */
const GOODNESS = {
	fixRate: (rate) => rate,
	shippedClean: (rate) => rate,
	criticalShare: (rate) => 1 - rate,
	firstTryGreen: (rate) => rate,
	rerunRate: (rate) => 1 - rate,
} satisfies Readonly<Record<RateKey, (rate: number) => number>>

export type Score = Readonly<{
	/** 0-100, unrounded so close scores still order. */
	score: number
	/** 0-1, the weighted mean of the shrunk columns. */
	quality: number
	/** 0-1, merged pull requests on a log scale, full at `VOLUME_REFERENCE`. */
	volume: number
}>

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0)

export const medianOf = (values: ReadonlyArray<number>): number | null => {
	if (values.length === 0) return null
	const sorted = values.toSorted((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Scores by login. People with no merged pull request have nothing to judge and are left out. */
export const teamScores = (members: ReadonlyArray<CodeReviewTeamMember>): ReadonlyMap<string, Score> => {
	const scored = members.filter((member) => member.mergedPullRequests > 0)

	// The team's pooled rate per column, over everyone, scored or not; null when nobody has evidence.
	const pooled = new Map(
		RATE_KEYS.map((key) => {
			const tallies = members.map(TALLIES[key])
			const trials = sum(tallies.map((tally) => tally.trials))
			return [key, trials === 0 ? null : sum(tallies.map((tally) => tally.hits)) / trials]
		}),
	)
	// Merge time has no pooled rate: the team median of medians, compared in log space.
	const mergeMedians = members.flatMap((m) =>
		m.mergedPullRequests > 0 && m.medianMergeSeconds !== null ? [m.medianMergeSeconds] : [],
	)
	const teamMerge = medianOf(mergeMedians)

	const goodnessOf = (member: CodeReviewTeamMember, key: ComponentKey): number | null => {
		const { prior } = COMPONENTS[key]
		if (key === "mergeTime") {
			if (teamMerge === null) return null
			const own =
				member.mergedPullRequests > 0 && member.medianMergeSeconds !== null
					? member.medianMergeSeconds
					: null
			const n = own === null ? 0 : member.mergedPullRequests
			const log = (n * Math.log1p(own ?? 0) + prior * Math.log1p(teamMerge)) / (n + prior)
			// The team median reads 0.5, twice as fast about 0.67, twice as slow about 0.33.
			return 1 / (1 + Math.expm1(log) / Math.max(teamMerge, 1))
		}
		const base = pooled.get(key) ?? null
		if (base === null) return null
		const tally = TALLIES[key](member)
		return GOODNESS[key]((tally.hits + prior * base) / (tally.trials + prior))
	}

	return new Map(
		scored.map((member) => {
			const parts = COMPONENT_KEYS.flatMap((key) => {
				const goodness = goodnessOf(member, key)
				return goodness === null ? [] : [{ weight: COMPONENTS[key].weight, goodness }]
			})
			const weights = sum(parts.map((part) => part.weight))
			const quality =
				weights === 0 ? 0.5 : sum(parts.map((part) => part.weight * part.goodness)) / weights
			const volume = Math.min(1, Math.log1p(member.mergedPullRequests) / Math.log1p(VOLUME_REFERENCE))
			const score = 100 * (QUALITY_SHARE * quality + (1 - QUALITY_SHARE) * volume)
			return [member.login, { score, quality, volume }]
		}),
	)
}
