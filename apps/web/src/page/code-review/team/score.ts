import type { CodeReviewTeamMember } from "@maple/domain/http"
import { Array as Arr, Order } from "effect"

// One 0-100 score per person: 80% quality, 20% merged volume against the team's median. Quality is
// how much of what the review raised reached the merge, each part a defect rate compared to the
// team's pooled rate: the team reads 0.5, half its rate about 0.67, twice it 0.33. Each rate is
// shrunk toward the team's by a few pseudo-observations, so one or two pull requests read close to
// average until there is evidence behind them. Shipped clean, reruns and merge time stay columns
// but are left out: post-merge regressions are judged per deploy and service, not per pull request.

/** Share of the score from quality; the rest is merged volume. */
const QUALITY_SHARE = 0.8

/** A defect count over its trials, e.g. findings left open over findings judged. Lower is better. */
type Tally = Readonly<{ defects: number; trials: number }>

type Component = Readonly<{
	weight: number
	/** Pseudo-observations of the team rate added to everyone's own. */
	prior: number
	tally: (member: CodeReviewTeamMember) => Tally
}>

const COMPONENTS: ReadonlyArray<Component> = [
	// Findings merged unfixed, of those judged.
	{
		weight: 0.4,
		prior: 15,
		tally: (m) => ({
			defects: m.openAtMergeFindings,
			trials: m.resolvedFindings + m.openAtMergeFindings,
		}),
	},
	// Findings merged unfixed per merged pull request: fixing 1 of 1 is not fixing 40 of 45.
	{
		weight: 0.3,
		prior: 20,
		tally: (m) => ({ defects: m.openAtMergeFindings, trials: m.mergedPullRequests }),
	},
	// Critical findings per reviewed pull request, not a share of findings, which nits would dilute.
	{ weight: 0.2, prior: 20, tally: (m) => ({ defects: m.criticalFindings, trials: m.pullRequests }) },
	{
		weight: 0.1,
		prior: 20,
		tally: (m) => ({ defects: m.firstTryRuns - m.firstTryGreen, trials: m.firstTryRuns }),
	},
]

export type Score = Readonly<{
	/** 0-100, unrounded so close scores still order. */
	score: number
	/** 0-1, the team reads 0.5. */
	quality: number
	/** 0-1, merged pull requests against the team median: the median reads 0.5, twice it 0.67. */
	volume: number
}>

const sum = (values: ReadonlyArray<number>) => Arr.reduce(values, 0, (total, value) => total + value)

export const medianOf = (values: ReadonlyArray<number>): number | null => {
	if (values.length === 0) return null
	const sorted = Arr.sort(values, Order.Number)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Scores by login. People with no merged pull request have nothing to judge and are left out. */
export const teamScores = (members: ReadonlyArray<CodeReviewTeamMember>): ReadonlyMap<string, Score> => {
	const scored = Arr.filter(members, (member) => member.mergedPullRequests > 0)
	// A median, so one outlier barely moves anyone else; scales with the window like the counts do.
	const teamMerged = medianOf(Arr.map(scored, (member) => member.mergedPullRequests)) ?? 1

	// The team's pooled rate per component, over everyone, scored or not. A component with no
	// evidence, or no defects anywhere, separates nobody and is left out.
	const pooled = Arr.map(COMPONENTS, (component) => {
		const tallies = Arr.map(members, component.tally)
		const trials = sum(Arr.map(tallies, (tally) => tally.trials))
		const rate = trials === 0 ? 0 : sum(Arr.map(tallies, (tally) => tally.defects)) / trials
		return rate > 0 ? rate : null
	})

	return new Map(
		Arr.map(scored, (member) => {
			const parts = Arr.flatMap(COMPONENTS, (component, index) => {
				const team = pooled[index] ?? null
				if (team === null) return []
				const { defects, trials } = component.tally(member)
				const own = (defects + component.prior * team) / (trials + component.prior)
				return [{ weight: component.weight, goodness: team / (team + own) }]
			})
			const weights = sum(Arr.map(parts, (part) => part.weight))
			const quality =
				weights === 0 ? 0.5 : sum(Arr.map(parts, (part) => part.weight * part.goodness)) / weights
			const volume = member.mergedPullRequests / (member.mergedPullRequests + teamMerged)
			const score = 100 * (QUALITY_SHARE * quality + (1 - QUALITY_SHARE) * volume)
			return [member.login, { score, quality, volume }]
		}),
	)
}
