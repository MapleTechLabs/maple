/**
 * What a pull request's security run tells GitHub: which confirmed findings fail the
 * `Maple / security` check, and the check's title, summary and annotations. Pure, so the gate's
 * rules are pinned by tests rather than by a run.
 *
 * A finding blocks when it is confirmed at or above the target's threshold and the pull request
 * brought it: not one a person dismissed or accepted, and not one the branch already had (a
 * finding the branch's own audit has seen, still open). Unconfirmed leads never block.
 * A run that could not finish fails open: neutral, so an outage never holds a merge.
 */
import type { PullRequestCheckAnnotation } from "@maple/domain/http"
import type { SecurityAuditFindingStatus, SecurityAuditRunStatus } from "@maple/domain/security-audit"
import type { Finding, Severity } from "@maple/security-audit"
import { Array as Arr, Option, Order, String as Str } from "effect"

export const SEVERITY_RANK = {
	informational: 0,
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
} as const satisfies Record<Severity, number>

/** The target's follow-up of a fingerprint, as far as the gate reads it. */
export interface FindingLifecycle {
	readonly status: SecurityAuditFindingStatus
	/** An audit of the branch itself has reported it: the code is already merged. */
	readonly seenOnBranch: boolean
}

export interface PrCheckVerdictInput {
	readonly findings: ReadonlyArray<Finding>
	readonly lifecycle: ReadonlyMap<string, FindingLifecycle>
	/** The lowest confirmed severity that fails the check; null never fails it. */
	readonly blockAt: Severity | null
	readonly run: {
		readonly status: SecurityAuditRunStatus
		readonly incompleteReason: string | null
		readonly error: string | null
	}
	/** The run's page in Maple, where findings are triaged. */
	readonly runUrl: string
}

export type FindingStanding = "blocking" | "reported" | "preexisting" | "accepted" | "lead"

export interface ClassifiedFinding {
	readonly finding: Finding
	readonly standing: FindingStanding
	readonly severity: Severity | null
}

export interface PrCheckVerdict {
	readonly conclusion: "success" | "neutral" | "failure"
	readonly title: string
	readonly summary: string
	readonly annotations: ReadonlyArray<PullRequestCheckAnnotation>
	readonly findings: ReadonlyArray<ClassifiedFinding>
}

const STANDING_ORDER = {
	blocking: 0,
	reported: 1,
	lead: 2,
	preexisting: 3,
	accepted: 4,
} as const satisfies Record<FindingStanding, number>

export const classifyFinding = (
	finding: Finding,
	lifecycle: FindingLifecycle | undefined,
	blockAt: Severity | null,
): ClassifiedFinding | null => {
	if (finding.verdict === "rejected") return null
	if (finding.verdict === "needs_validation") return { finding, standing: "lead", severity: null }
	const severity = finding.severity.overall_severity
	const standing: FindingStanding =
		lifecycle?.status === "dismissed" || lifecycle?.status === "accepted_risk"
			? "accepted"
			: lifecycle?.status === "open" && lifecycle.seenOnBranch
				? "preexisting"
				: blockAt !== null && SEVERITY_RANK[severity] >= SEVERITY_RANK[blockAt]
					? "blocking"
					: "reported"
	return { finding, standing, severity }
}

/** Where the finding lands in the code: its sink, else its first evidence, else its first step. */
export const findingLocation = (
	finding: Finding,
): { readonly file: string; readonly line: number } | null => {
	const sink = Arr.findFirst(finding.trace, (step) => step.kind === "sink")
	if (Option.isSome(sink)) return { file: sink.value.file, line: sink.value.line }
	const first = finding.evidence[0] ?? finding.trace[0]
	return first === undefined ? null : { file: first.file, line: first.line }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const cell = (value: string) =>
	Str.replace(/`/g, "'")(Str.replace(/\n/g, " ")(Str.replace(/[\\|]/g, "\\$&")(value)))

/** GitHub refuses an annotation title over 255 characters, and a summary over 65,535. */
const MAX_ANNOTATION_TITLE = 255
const MAX_SUMMARY = 60_000
const clip = (value: string, max: number) =>
	value.length <= max ? value : `${Str.slice(0, max - 1)(value)}…`

const STANDING_LABEL = {
	blocking: "Blocks merge",
	reported: "Below threshold",
	lead: "Unconfirmed",
	preexisting: "Already on the branch",
	accepted: "Dismissed or accepted",
} as const satisfies Record<FindingStanding, string>

const ANNOTATION_LEVEL = {
	blocking: "failure",
	reported: "warning",
	lead: "notice",
	preexisting: "notice",
	accepted: null,
} as const satisfies Record<FindingStanding, PullRequestCheckAnnotation["level"] | null>

/** GitHub truncates past this; the run page holds everything. */
const MAX_TABLE_ROWS = 25

export const prCheckVerdict = (input: PrCheckVerdictInput): PrCheckVerdict => {
	const classified = Arr.sort(
		Arr.flatMap(input.findings, (finding) => {
			const result = classifyFinding(finding, input.lifecycle.get(finding.fingerprint), input.blockAt)
			return result === null ? [] : [result]
		}),
		Order.combine(
			Order.mapInput(Order.Number, (c: ClassifiedFinding) => STANDING_ORDER[c.standing]),
			Order.mapInput(
				Order.Number,
				(c: ClassifiedFinding) => -(c.severity === null ? -1 : SEVERITY_RANK[c.severity]),
			),
		),
	)
	const count = (standing: FindingStanding) => Arr.filter(classified, (c) => c.standing === standing).length
	const blocking = count("blocking")
	const finished = input.run.status === "complete"
	const conclusion = blocking > 0 ? "failure" : finished ? "success" : "neutral"

	// A failure's text is internal (stack traces, sandbox output): GitHub gets a plain reason, and
	// the run page keeps the detail.
	const unfinishedReason =
		input.run.status === "failed"
			? "the audit hit an error"
			: clip(input.run.incompleteReason ?? "the run ended early", 200)
	const title =
		blocking > 0
			? `${plural(blocking, "security issue")} ${blocking === 1 ? "blocks" : "block"} this merge`
			: finished
				? count("reported") > 0
					? `No blocking issues · ${plural(count("reported"), "finding")} below the threshold`
					: "No security issues found"
				: "Could not finish · not blocking"

	const thresholdLine =
		input.blockAt === null
			? "This check reports findings without failing."
			: `Confirmed findings at **${input.blockAt}** or above fail this check.`
	const rows = Arr.map(Arr.take(classified, MAX_TABLE_ROWS), (c) => {
		const where = findingLocation(c.finding)
		return `| ${STANDING_LABEL[c.standing]} | ${c.severity ?? "–"} | ${cell(c.finding.title)} | ${where === null ? "–" : `\`${cell(where.file)}:${where.line}\``} |`
	})
	const summary = clip(
		Arr.join(
			[
				...(finished
					? []
					: [
							`The security audit could not finish (${unfinishedReason}), so this check does not block the merge.`,
							"",
						]),
				thresholdLine,
				"",
				...(classified.length === 0
					? [
							finished
								? "The audit of this pull request's changed files found nothing."
								: "No findings so far.",
						]
					: [
							"| | Severity | Finding | Where |",
							"|---|---|---|---|",
							...rows,
							...(classified.length > MAX_TABLE_ROWS
								? [``, `${classified.length - MAX_TABLE_ROWS} more on the run page.`]
								: []),
						]),
				"",
				...(blocking > 0
					? [
							`To unblock: push a fix, or dismiss the finding or accept its risk with a reason on [the run page](${input.runUrl}). Either re-reports this check.`,
						]
					: [`Details, evidence and fixes: [the run page](${input.runUrl}).`]),
			],
			"\n",
		),
		MAX_SUMMARY,
	)

	const annotations = Arr.flatMap(classified, (c): ReadonlyArray<PullRequestCheckAnnotation> => {
		const level = ANNOTATION_LEVEL[c.standing]
		const where = findingLocation(c.finding)
		if (level === null || where === null) return []
		return [
			{
				path: where.file,
				startLine: Math.max(1, where.line),
				endLine: Math.max(1, where.line),
				level,
				title: clip(
					`${c.severity === null ? "Unconfirmed lead" : `Security · ${c.severity}`}: ${c.finding.title}`,
					MAX_ANNOTATION_TITLE,
				),
				message: `${STANDING_LABEL[c.standing]}. ${c.finding.description}`,
			},
		]
	})

	return { conclusion, title, summary, annotations, findings: classified }
}
