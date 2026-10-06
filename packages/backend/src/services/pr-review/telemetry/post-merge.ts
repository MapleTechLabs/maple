/**
 * The look at production after a reviewed pull request ships: which deploy carried it, how the
 * operations it touched behaved the hour before and after, and whether the errors in its files
 * stopped. Pure; the tick service reads the warehouse and posts the result.
 */
import {
	openContractBreaks,
	type PrReviewPostMerge,
	PrReviewPostMergeOperation,
	type PrReviewTelemetry,
} from "@maple/domain/http"
import { formatCount } from "./analyze"
import { escapeCell } from "./render"

/** The two windows compared around the deploy. */
export const POST_MERGE_WINDOW_MINUTES = 60
/** How long after the merge a deploy is waited for before the look is given up. */
export const POST_MERGE_GIVE_UP_MS = 48 * 3_600_000
/** How long after the merge the first look happens; most pipelines deploy within it. */
export const POST_MERGE_FIRST_LOOK_MS = 15 * 60_000
/** How often a row with no deploy yet is looked at again. */
export const POST_MERGE_RETRY_MS = 30 * 60_000
/** How long the merge commit's own version is waited for before a later version stands in. */
export const POST_MERGE_EXACT_WAIT_MS = 2 * 3_600_000

/** Below this many calls in the hour after, a change in rate is noise. */
const MIN_CALLS = 20
const ERROR_RATE_JUMP = 0.02
const P95_RATIO = 1.5
const P95_MIN_DELTA_MS = 100
/** The operations compared: the busiest the review saw. */
export const MAX_COMPARED_OPERATIONS = 10

export interface Deployment {
	readonly service: string
	readonly environment: string
	readonly commitSha: string
	readonly firstSeenAt: number
}

/**
 * The deploy that shipped the merge: the version whose commit is the merge commit. When that commit
 * has not reported within {@link POST_MERGE_EXACT_WAIT_MS} (a pipeline that deploys a later commit),
 * the first version reported after the merge stands in, skipping any whose commit is known to be
 * older than the merge, since that one cannot carry it. `exactOnly` waits for the merge commit
 * alone, for a look that has no touched service to narrow the versions by.
 */
export const pickDeploy = (input: {
	readonly versions: ReadonlyArray<Deployment>
	readonly mergeCommitSha: string | null
	readonly mergedAtMs: number
	readonly nowMs: number
	/** Commit times by lower-cased SHA, where the repository's commits are known. */
	readonly commitTimes: ReadonlyMap<string, number>
	readonly exactOnly: boolean
}): { readonly deploy: Deployment; readonly exact: boolean } | undefined => {
	const merge = input.mergeCommitSha?.toLowerCase()
	const exact = input.versions.find((version) => version.commitSha.toLowerCase() === merge)
	if (exact !== undefined) return { deploy: exact, exact: true }
	if (input.exactOnly || input.nowMs - input.mergedAtMs < POST_MERGE_EXACT_WAIT_MS) return undefined
	const first = input.versions
		.filter((version) => version.firstSeenAt >= input.mergedAtMs)
		.filter(
			(version) =>
				(input.commitTimes.get(version.commitSha.toLowerCase()) ?? input.mergedAtMs) >=
				input.mergedAtMs,
		)
		.sort((a, b) => a.firstSeenAt - b.firstSeenAt)[0]
	return first === undefined ? undefined : { deploy: first, exact: false }
}

export interface WindowStats {
	readonly service: string
	readonly spanName: string
	readonly count: number
	readonly errorCount: number
	readonly p95Ms: number
}

const rate = (stats: WindowStats | undefined) =>
	stats === undefined || stats.count === 0 ? 0 : stats.errorCount / stats.count

/** Whether the hour after is worse than the hour before, by error rate or by latency. */
export const operationRegressed = (
	before: WindowStats | undefined,
	after: WindowStats | undefined,
): boolean => {
	if (after === undefined || after.count < MIN_CALLS) return false
	const errorsWorse = rate(after) - rate(before) >= ERROR_RATE_JUMP && rate(after) >= 2 * rate(before)
	const slower =
		before !== undefined &&
		before.count >= MIN_CALLS &&
		after.p95Ms >= P95_RATIO * before.p95Ms &&
		after.p95Ms - before.p95Ms >= P95_MIN_DELTA_MS
	return errorsWorse || slower
}

const key = (service: string, spanName: string) => `${service}\u0000${spanName}`

/** The operations the review weighed, busiest first, with the windows around the deploy. */
export const compareOperations = (
	telemetry: PrReviewTelemetry,
	before: ReadonlyArray<WindowStats>,
	after: ReadonlyArray<WindowStats>,
): ReadonlyArray<PrReviewPostMergeOperation> => {
	const beforeBy = new Map(before.map((row) => [key(row.service, row.spanName), row] as const))
	const afterBy = new Map(after.map((row) => [key(row.service, row.spanName), row] as const))
	const hours = POST_MERGE_WINDOW_MINUTES / 60
	return comparedOperations(telemetry).map((operation) => {
		const was = beforeBy.get(key(operation.service, operation.spanName))
		const now = afterBy.get(key(operation.service, operation.spanName))
		return new PrReviewPostMergeOperation({
			service: operation.service,
			spanName: operation.spanName,
			before: {
				perHour: Math.round((was?.count ?? 0) / hours),
				errorRate: rate(was),
				p95Ms: Math.round(was?.p95Ms ?? 0),
			},
			after: {
				perHour: Math.round((now?.count ?? 0) / hours),
				errorRate: rate(now),
				p95Ms: Math.round(now?.p95Ms ?? 0),
			},
			regressed: operationRegressed(was, now),
		})
	})
}

/** The operations worth comparing: every one the changed files named, busiest first. */
export const comparedOperations = (telemetry: PrReviewTelemetry) => {
	const seen = new Map<
		string,
		{ readonly service: string; readonly spanName: string; readonly perDay: number }
	>()
	for (const file of telemetry.hotFiles) {
		for (const operation of file.operations) {
			const id = key(operation.service, operation.spanName)
			if (!seen.has(id)) seen.set(id, operation)
		}
	}
	return [...seen.values()].sort((a, b) => b.perDay - a.perDay).slice(0, MAX_COMPARED_OPERATIONS)
}

/** Services worth a deploy lookup: the ones the changed files' operations and errors live in. */
export const postMergeServices = (telemetry: PrReviewTelemetry): ReadonlyArray<string> => [
	...new Set([...telemetry.services, ...telemetry.linkedIssues.map((issue) => issue.service)]),
]

/** Attribute names a contract break said alerts read, that no longer arrive after the deploy. */
export const missingAfterDeploy = (
	telemetry: PrReviewTelemetry,
	arrivingAfter: ReadonlySet<string>,
): ReadonlyArray<string> =>
	openContractBreaks(telemetry)
		.filter((item) => item.kind === "attribute" && !arrivingAfter.has(item.name))
		.map((item) => item.name)

export const postMergeMarker = (reviewId: string) => `<!-- maple-pr-post-merge ${reviewId} -->`

const pct = (value: number) => `${(value * 100).toFixed(1)}%`

/** The follow-up comment on the merged pull request. */
export const renderPostMergeComment = (reviewId: string, postMerge: PrReviewPostMerge): string => {
	const { deploy } = postMerge
	const when = new Date(deploy.firstSeenAt).toISOString().slice(0, 16).replace("T", " ")
	const lines = [
		postMergeMarker(reviewId),
		"## Maple: after this shipped",
		"",
		postMerge.verdict === "clean"
			? "✅ **Shipped clean.** Nothing this change touches got worse in the hour after it deployed."
			: "⚠️ **Something changed after this shipped.** Details below.",
		"",
		`Deployed to \`${deploy.service}\`${deploy.environment ? ` (${deploy.environment})` : ""} at ${when} UTC as \`${deploy.commitSha.slice(0, 7)}\`${deploy.exact ? "" : ", the first version after the merge (the merge commit itself never reported)"}. Compared the ${postMerge.windowMinutes} minutes before and after.`,
		"",
	]
	if (postMerge.missing.length > 0) {
		lines.push(
			"**Stopped arriving** (alerts read these):",
			...postMerge.missing.map((name) => `- \`${name}\``),
			"",
		)
	}
	if (postMerge.newIssues.length > 0) {
		lines.push(
			"**New errors since the deploy:**",
			...postMerge.newIssues.map(
				(issue) => `- ${issue.title} (${issue.service}, ${formatCount(issue.afterPerHour)}/h)`,
			),
			"",
		)
	}
	if (postMerge.linkedIssues.length > 0) {
		lines.push(
			"**Errors in the changed files:**",
			...postMerge.linkedIssues.map((issue) => {
				const stopped = issue.beforePerHour > 0 && issue.afterPerHour === 0
				return `- ${stopped ? "✅" : issue.afterPerHour > 0 ? "🔁" : "➖"} ${issue.title}: ${formatCount(issue.beforePerHour)}/h → ${formatCount(issue.afterPerHour)}/h${stopped ? ", stopped" : issue.afterPerHour > 0 ? ", still occurring" : ""}`
			}),
			"",
		)
	}
	if (postMerge.operations.length > 0) {
		lines.push(
			"| Operation | Calls/h | Errors | p95 |",
			"| --- | ---: | ---: | ---: |",
			...postMerge.operations.map(
				(operation) =>
					`| ${operation.regressed ? "⚠️ " : ""}\`${escapeCell(operation.spanName)}\` | ${formatCount(operation.before.perHour)} → ${formatCount(operation.after.perHour)} | ${pct(operation.before.errorRate)} → ${pct(operation.after.errorRate)} | ${operation.before.p95Ms} → ${operation.after.p95Ms} ms |`,
			),
			"",
		)
	}
	lines.push("<sub>Maple looks once, an hour after the first deploy that carries the merge.</sub>")
	return lines.join("\n")
}
