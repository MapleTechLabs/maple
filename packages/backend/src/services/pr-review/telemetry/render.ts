/**
 * How the telemetry facts reach the agent, the findings and the comment. Pure: the service decides
 * what is true, this decides how it is said.
 */
import {
	openContractBreaks,
	PrReviewContractBreak,
	PrReviewFinding,
	type PrReviewSeverity,
	type PrReviewTelemetry,
	PrReviewTelemetry as PrReviewTelemetryClass,
	type PrReviewTelemetryDismissal,
} from "@maple/domain/http"
import { formatCount, formatGb } from "./analyze"

/** Calls a day past which a file's gaps are worth a warning rather than a note. */
export const HOT_PER_DAY = 10_000
/** Ingest a month past which a new log line is a warning rather than a note. */
const COST_WARN_GB = 10
const COST_FINDING_MIN_GB = 1

const KIND_LABEL = { span: "span name", attribute: "attribute", metric: "metric" } as const

const referenceList = (item: PrReviewContractBreak) =>
	item.references.map((ref) => `${ref.kind} “${ref.name}”`).join(", ")

const hasAlert = (item: PrReviewContractBreak) => item.references.some((ref) => ref.kind === "alert")

const readers = (item: PrReviewContractBreak) => {
	const [only] = item.references
	if (item.references.length === 1 && only !== undefined) return `${only.kind} “${only.name}” reads`
	const kinds = new Set(item.references.map((ref) => ref.kind))
	const noun = kinds.size === 2 ? "alerts and dashboards" : hasAlert(item) ? "alerts" : "dashboards"
	return `${item.references.length} ${noun} read`
}

/**
 * The block the agent reads after the pull request's description. Facts with a job attached: the
 * service files the breaks and costs itself, so the agent only verifies and weighs.
 */
export const renderTelemetryKickoff = (telemetry: PrReviewTelemetry | undefined): ReadonlyArray<string> => {
	if (telemetry === undefined) return []
	const lines: Array<string> = []
	const breaks = telemetry.contractBreaks
	if (breaks.length > 0) {
		lines.push(
			"Names this pull request removes that the organization's alerts or dashboards read (Maple files each as a finding itself; do not file your own):",
			...breaks.map(
				(item) =>
					`- \`${item.name}\` (${KIND_LABEL[item.kind]}, ~${formatCount(item.perDay ?? 0)}/day) removed at ${item.path}:${item.line}; read by ${referenceList(item)}`,
			),
			"For each, sandbox_grep the head for the name. If code at the head still emits it, pass that location in submit_review's telemetryDismissals as {name, path, line}; Maple reads that line before it accepts the dismissal. Otherwise leave it.",
			"",
		)
	}
	if (telemetry.hotFiles.length > 0) {
		lines.push(
			`Production traffic of the operations the changed files name, last ${telemetry.windowDays} days:`,
			...telemetry.hotFiles.map(
				(file) =>
					`- ${file.path}: ~${formatCount(file.perDay)} calls/day (${file.operations
						.slice(0, 3)
						.map(
							(operation) =>
								`${operation.service} \`${operation.spanName}\` ${formatCount(operation.perDay)}/day, ${(operation.errorRate * 100).toFixed(1)}% errors, p95 ${operation.p95Ms} ms`,
						)
						.join("; ")})`,
			),
			`Weigh findings by this traffic: a gap on a path that serves thousands of calls a day matters more than one on a path with none. Maple raises observability and performance notes in files above ${formatCount(HOT_PER_DAY)} calls/day to warnings.`,
			"",
		)
	}
	if (telemetry.linkedIssues.length > 0) {
		lines.push(
			"Open error issues whose top stack frame is in a changed file:",
			...telemetry.linkedIssues.map(
				(issue) =>
					`- ${issue.title} (${issue.service}, ${formatCount(issue.occurrences)} occurrences) at ${issue.topFrame} → ${issue.path}`,
			),
			"Say in the summary whether this change addresses each one, and only claim a fix the diff shows.",
			"",
		)
	}
	return lines
}

/** The facts the service files as findings itself: open contract breaks and costly additions. */
export const telemetryFindings = (
	telemetry: PrReviewTelemetry | undefined,
): ReadonlyArray<PrReviewFinding> => {
	if (telemetry === undefined) return []
	const breaks = openContractBreaks(telemetry).map(
		(item) =>
			new PrReviewFinding({
				path: item.path,
				line: item.line,
				category: "observability",
				checkId: "TEL-01",
				severity: hasAlert(item) ? "critical" : "warn",
				title: `Removes \`${item.name}\`, which ${readers(item)}`,
				body: [
					`\`${item.name}\` is a ${KIND_LABEL[item.kind]} production emits about ${formatCount(item.perDay ?? 0)} times a day, and this pull request removes it without adding it back anywhere.`,
					`Read by ${referenceList(item)}. ${hasAlert(item) ? "An alert that filters on a name that stops arriving goes quiet instead of firing." : "Widgets that read it go empty."}`,
					`Keep the name, or update ${item.references.length === 1 ? "it" : "them"} in the same change.`,
				].join("\n\n"),
			}),
	)
	const costs = telemetry.costNotes.flatMap((note) => {
		if (note.kind === "span_name") {
			return [
				new PrReviewFinding({
					path: note.path,
					line: note.line,
					category: "observability",
					checkId: "TEL-03",
					severity: "warn",
					title: "Span name built from a runtime value",
					body: note.note,
				}),
			]
		}
		const gb = note.gbPerMonth ?? 0
		if (gb < COST_FINDING_MIN_GB) return []
		return [
			new PrReviewFinding({
				path: note.path,
				line: note.line,
				category: "performance",
				checkId: "TEL-02",
				severity: gb >= COST_WARN_GB ? "warn" : "info",
				title: `New log line on a busy path, about ${formatGb(gb)} of logs a month`,
				body: `${note.note} Log at debug, sample it, or attach the detail to the span instead.`,
			}),
		]
	})
	return [...breaks, ...costs]
}

const RAISED_CATEGORIES = new Set(["observability", "performance"])

/**
 * The model's findings, weighed by production traffic: a note about observability or performance
 * in a file that serves more than {@link HOT_PER_DAY} calls a day becomes a warning, and says so.
 */
export const weighByTraffic = (
	findings: ReadonlyArray<PrReviewFinding>,
	telemetry: PrReviewTelemetry | undefined,
): ReadonlyArray<PrReviewFinding> => {
	if (telemetry === undefined || telemetry.hotFiles.length === 0) return findings
	const traffic = new Map(telemetry.hotFiles.map((file) => [file.path, file] as const))
	return findings.map((finding) => {
		const file = traffic.get(finding.path)
		if (
			file === undefined ||
			file.perDay < HOT_PER_DAY ||
			finding.severity !== "info" ||
			!RAISED_CATEGORIES.has(finding.category)
		)
			return finding
		const busiest = file.operations[0]
		const severity: PrReviewSeverity = "warn"
		return new PrReviewFinding({
			...finding,
			severity,
			body: `${finding.body}\n\nRaised from a note: this file's operations serve about ${formatCount(file.perDay)} calls a day in production${busiest === undefined ? "" : ` (busiest \`${busiest.spanName}\`)`}.`,
		})
	})
}

/** The telemetry with the dismissals the service verified recorded on their breaks. */
export const withDismissals = (
	telemetry: PrReviewTelemetry,
	verified: ReadonlyArray<PrReviewTelemetryDismissal>,
): PrReviewTelemetry =>
	verified.length === 0
		? telemetry
		: new PrReviewTelemetryClass({
				...telemetry,
				contractBreaks: telemetry.contractBreaks.map((item) => {
					const proof = verified.find((dismissal) => dismissal.name === item.name)
					return proof === undefined || item.dismissed !== undefined
						? item
						: new PrReviewContractBreak({
								...item,
								dismissed: { path: proof.path, line: proof.line },
							})
				}),
			})

/**
 * Whether a line at the head still emits a name: it holds the name as a string, and is code rather
 * than a comment or a test.
 */
export const lineStillEmits = (content: string, line: number, name: string): boolean => {
	const text = content.split("\n")[line - 1]
	if (text === undefined) return false
	const trimmed = text.trim()
	if (/^(\/\/|#|\*|\/\*|--)/.test(trimmed)) return false
	return [`"${name}"`, `'${name}'`, `\`${name}\``].some((quoted) => text.includes(quoted))
}

const escapeCell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ")

/**
 * The comment's section on production: what breaks, where the traffic is, which open errors live
 * in the changed files, and what the change adds to or removes from the telemetry.
 */
export const renderTelemetryMarkdown = (
	telemetry: PrReviewTelemetry | undefined,
	options: { readonly blocking: boolean },
): ReadonlyArray<string> => {
	if (telemetry === undefined) return []
	const open = openContractBreaks(telemetry)
	const dismissed = telemetry.contractBreaks.filter((item) => item.dismissed !== undefined)
	const sections: Array<string> = []
	if (open.length > 0) {
		sections.push(
			"> [!CAUTION]",
			`> **${open.length === 1 ? "A name" : `${open.length} names`} your alerts or dashboards read stop${open.length === 1 ? "s" : ""} arriving after this ships.**${options.blocking ? " This check fails until each is kept or its readers are updated (repository setting)." : ""}`,
			...open.map(
				(item) =>
					`> - \`${item.name}\` (${KIND_LABEL[item.kind]}, ~${formatCount(item.perDay ?? 0)}/day): ${referenceList(item)}`,
			),
			"",
		)
	}
	if (telemetry.linkedIssues.length > 0) {
		sections.push(
			"<details open><summary>Open errors in the changed files</summary>",
			"",
			"| Issue | Service | Occurrences | File |",
			"| --- | --- | ---: | --- |",
			...telemetry.linkedIssues.map(
				(issue) =>
					`| ${escapeCell(issue.title)} | ${escapeCell(issue.service)} | ${formatCount(issue.occurrences)} | \`${escapeCell(issue.path)}\` |`,
			),
			"",
			"After this merges, Maple checks whether they stop.",
			"",
			"</details>",
			"",
		)
	}
	if (telemetry.hotFiles.length > 0) {
		sections.push(
			`<details><summary>Production traffic of the changed files (last ${telemetry.windowDays} days)</summary>`,
			"",
			"| File | Calls/day | Busiest operations |",
			"| --- | ---: | --- |",
			...telemetry.hotFiles.map(
				(file) =>
					`| \`${escapeCell(file.path)}\` | ${formatCount(file.perDay)} | ${file.operations
						.slice(0, 3)
						.map(
							(operation) =>
								`\`${escapeCell(operation.spanName)}\` ${formatCount(operation.perDay)}/day, ${(operation.errorRate * 100).toFixed(1)}% err`,
						)
						.join("<br>")} |`,
			),
			"",
			"</details>",
			"",
		)
	}
	const changes = [
		...telemetry.removed.map(
			(item) =>
				`- ➖ ${KIND_LABEL[item.kind]} \`${item.name}\`${item.perDay === undefined ? "" : ` (~${formatCount(item.perDay)}/day today)`} · \`${item.path}:${item.line}\``,
		),
		...telemetry.added.map(
			(item) => `- ➕ ${KIND_LABEL[item.kind]} \`${item.name}\` · \`${item.path}:${item.line}\``,
		),
	]
	if (changes.length > 0) {
		sections.push(
			`<details><summary>Telemetry this change adds and removes (${changes.length})</summary>`,
			"",
			...changes,
			...(dismissed.length > 0
				? [
						"",
						"Removed here but still emitted elsewhere at this commit:",
						...dismissed.map(
							(item) =>
								`- \`${item.name}\` · \`${item.dismissed?.path}:${item.dismissed?.line}\``,
						),
					]
				: []),
			"",
			"</details>",
			"",
		)
	}
	const costs = telemetry.costNotes.filter((note) => note.kind === "log")
	if (costs.length > 0) {
		sections.push(
			"<details><summary>Ingest cost of new log lines</summary>",
			"",
			...costs.map((note) => `- \`${note.path}:${note.line}\`: ${note.note}`),
			"",
			"</details>",
			"",
		)
	}
	return sections.length === 0 ? [] : ["### Production impact", "", ...sections]
}

const BREAK_TITLE = /^Removes `(.+?)`, which /

/**
 * Open contract-break findings from earlier pushes that this head no longer causes: the pull
 * request now keeps the name, or a dismissal proved it is still emitted. Unknown without the facts.
 */
export const fixedContractBreaks = <F extends { readonly title: string; readonly category: string }>(
	open: ReadonlyArray<F>,
	telemetry: PrReviewTelemetry | undefined,
): ReadonlyArray<F> => {
	if (telemetry === undefined) return []
	const breaking = new Set(openContractBreaks(telemetry).map((item) => item.name))
	return open.filter((finding) => {
		const name = finding.category === "observability" ? BREAK_TITLE.exec(finding.title)?.[1] : undefined
		return name !== undefined && !breaking.has(name)
	})
}
