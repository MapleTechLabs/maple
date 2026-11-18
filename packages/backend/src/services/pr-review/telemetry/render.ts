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
	type PrReviewTelemetryKind,
} from "@maple/domain/http"
import { formatCount, formatGb } from "./analyze"
import { lineEmitsAt } from "./diff"
import { Array as Arr, Option, String as Str } from "effect"

/** Calls a day past which a file's gaps are worth a warning rather than a note. */
export const HOT_PER_DAY = 10_000
/** Ingest a month past which a new log line is a warning rather than a note. */
const COST_WARN_GB = 10
const COST_FINDING_MIN_GB = 1

const KIND_LABEL = { span: "span name", attribute: "attribute", metric: "metric" } as const

const referenceList = (item: PrReviewContractBreak) =>
	Arr.join(
		Arr.map(item.references, (ref) => `${ref.kind} “${ref.name}”`),
		", ",
	)

const hasAlert = (item: PrReviewContractBreak) => Arr.some(item.references, (ref) => ref.kind === "alert")

/** The alerts and dashboards reading a name, by count only where the review is world-readable. */
const readerCount = (item: PrReviewContractBreak) =>
	`${item.references.length} ${item.references.length === 1 ? (hasAlert(item) ? "alert" : "dashboard") : "alerts or dashboards"}`

const readers = (item: PrReviewContractBreak, withText: boolean) => {
	if (!withText) return `${readerCount(item)} ${item.references.length === 1 ? "reads" : "read"}`
	const [only] = item.references
	if (item.references.length === 1 && only !== undefined) return `${only.kind} “${only.name}” reads`
	const kinds = new Set(Arr.map(item.references, (ref) => ref.kind))
	const noun = kinds.size === 2 ? "alerts and dashboards" : hasAlert(item) ? "alerts" : "dashboards"
	return `${item.references.length} ${noun} read`
}

/**
 * The block the agent reads after the pull request's description. Facts with a job attached: the
 * service files the breaks and costs itself, so the agent only verifies and weighs.
 *
 * On a public repository the review is world-readable and anyone with the ingest key writes the
 * org's telemetry, so only counts reach it: no service, span or error text.
 */
export const renderTelemetryKickoff = (
	telemetry: PrReviewTelemetry | undefined,
	repository: { readonly isPrivate: boolean },
): ReadonlyArray<string> => {
	if (telemetry === undefined) return []
	const lines: Array<string> = []
	const withText = repository.isPrivate
	const breaks = openContractBreaks(telemetry)
	if (breaks.length > 0) {
		lines.push(
			"Names this pull request removes that the organization's alerts or dashboards read (Maple files each as a finding itself; do not file your own):",
			...Arr.map(
				breaks,
				(item) =>
					`- \`${item.name}\` (${KIND_LABEL[item.kind]}, ~${formatCount(item.perDay ?? 0)}/day) removed at ${item.path}:${item.line}; read by ${withText ? referenceList(item) : readerCount(item)}`,
			),
			"For each, sandbox_grep the head for the name. If code at the head still emits it, pass that location in submit_review's telemetryDismissals as {name, path, line}; Maple reads that line before it accepts the dismissal. Otherwise leave it.",
			"",
		)
	}
	if (telemetry.hotFiles.length > 0) {
		lines.push(
			`Production traffic of the operations the changed files name, last ${telemetry.windowDays} days:`,
			...Arr.map(telemetry.hotFiles, (file) =>
				withText
					? `- ${file.path}: ~${formatCount(file.perDay)} calls/day (${Arr.join(
							Arr.map(
								file.operations.slice(0, 3),
								(operation) =>
									`${operation.service} \`${operation.spanName}\` ${formatCount(operation.perDay)}/day, ${(operation.errorRate * 100).toFixed(1)}% errors, p95 ${operation.p95Ms} ms`,
							),
							"; ",
						)})`
					: `- ${file.path}: ~${formatCount(file.perDay)} calls/day`,
			),
			`Weigh findings by this traffic: a gap on a path that serves thousands of calls a day matters more than one on a path with none. Maple raises observability and performance notes in files above ${formatCount(HOT_PER_DAY)} calls/day to warnings.`,
			"",
		)
	}
	if (telemetry.linkedIssues.length > 0) {
		lines.push(
			"Open error issues whose top stack frame is in a changed file:",
			...Arr.map(telemetry.linkedIssues, (issue) =>
				withText
					? `- ${issue.title} (${issue.service}, ${formatCount(issue.occurrences)} occurrences) at ${issue.topFrame} → ${issue.path}`
					: `- An issue with ${formatCount(issue.occurrences)} occurrences → ${issue.path}`,
			),
			"Say in the summary whether this change addresses each one, and only claim a fix the diff shows.",
			"",
		)
	}
	return lines
}

/**
 * The facts the service files as findings itself: open contract breaks and costly additions. On a
 * public repository no alert or dashboard name is posted, only how many read the removed name.
 */
export const telemetryFindings = (
	telemetry: PrReviewTelemetry | undefined,
	repository: { readonly isPrivate: boolean },
): ReadonlyArray<PrReviewFinding> => {
	if (telemetry === undefined) return []
	const withText = repository.isPrivate
	const breaks = Arr.map(
		openContractBreaks(telemetry),
		(item) =>
			new PrReviewFinding({
				path: item.path,
				line: item.line,
				category: "observability",
				checkId: "TEL-01",
				severity: hasAlert(item) ? "critical" : "warn",
				title: `Removes \`${item.name}\`, which ${readers(item, withText)}`,
				body: Arr.join(
					[
						`\`${item.name}\` is a ${KIND_LABEL[item.kind]} production emits about ${formatCount(item.perDay ?? 0)} times a day, and this pull request removes it without adding it back anywhere.`,
						`Read by ${withText ? referenceList(item) : readerCount(item)}. ${hasAlert(item) ? "An alert that filters on a name that stops arriving goes quiet instead of firing." : "Widgets that read it go empty."}`,
						`Keep the name, or update ${item.references.length === 1 ? "it" : "them"} in the same change.`,
					],
					"\n\n",
				),
			}),
	)
	const costs = Arr.flatMap(telemetry.costNotes, (note) => {
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
	repository: { readonly isPrivate: boolean },
): ReadonlyArray<PrReviewFinding> => {
	if (telemetry === undefined || telemetry.hotFiles.length === 0) return findings
	const traffic = new Map(Arr.map(telemetry.hotFiles, (file) => [file.path, file] as const))
	return Arr.map(findings, (finding) => {
		const file = traffic.get(finding.path)
		if (
			file === undefined ||
			file.perDay < HOT_PER_DAY ||
			finding.severity !== "info" ||
			!RAISED_CATEGORIES.has(finding.category)
		)
			return finding
		// A public repository's comment names no span: anyone with the ingest key writes them.
		const busiest = repository.isPrivate ? file.operations[0] : undefined
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
				contractBreaks: Arr.map(telemetry.contractBreaks, (item) => {
					const proof = Arr.findFirst(verified, (dismissal) => dismissal.name === item.name)
					return Option.isNone(proof) || item.dismissed !== undefined
						? item
						: new PrReviewContractBreak({
								...item,
								dismissed: { path: proof.value.path, line: proof.value.line },
							})
				}),
			})

/** Whether a line at the head still hands a removed name to the telemetry API, as the same kind. */
export const lineStillEmits = (
	content: string,
	line: number,
	name: string,
	kind: PrReviewTelemetryKind,
): boolean => lineEmitsAt(content, line, name, kind)

/** Text for a markdown table cell: backslashes escaped with the pipes, so an escaped pipe cannot be unescaped. */
export const escapeCell = (value: string) => Str.replace(/\n/g, " ")(Str.replace(/[\\|]/g, "\\$&")(value))

/**
 * Open issues as one row per title, service and file: separate fingerprints of the same error read
 * as the same row repeated, so they are summed.
 */
const groupIssues = (issues: PrReviewTelemetry["linkedIssues"]) =>
	Arr.reduce(
		issues,
		Arr.empty<{ title: string; service: string; path: string; occurrences: number; count: number }>(),
		(rows, issue) => {
			const found = Arr.findFirst(
				rows,
				(item) =>
					item.title === issue.title && item.service === issue.service && item.path === issue.path,
			)
			if (Option.isNone(found)) {
				rows.push({
					title: issue.title,
					service: issue.service,
					path: issue.path,
					occurrences: issue.occurrences,
					count: 1,
				})
			} else {
				found.value.occurrences += issue.occurrences
				found.value.count += 1
			}
			return rows
		},
	)

/**
 * The section on production: what breaks, which open errors live in the changed files, and, on the
 * check run only (`brief` is the comment), where the traffic is and what telemetry the change adds
 * or removes. On a public repository it names no alert, dashboard, service, span or error: counts only.
 */
export const renderTelemetryMarkdown = (
	telemetry: PrReviewTelemetry | undefined,
	options: { readonly blocking: boolean; readonly brief?: boolean; readonly isPrivate: boolean },
): ReadonlyArray<string> => {
	if (telemetry === undefined) return []
	const withText = options.isPrivate
	const open = openContractBreaks(telemetry)
	const dismissed = Arr.filter(telemetry.contractBreaks, (item) => item.dismissed !== undefined)
	const sections: Array<string> = []
	if (open.length > 0) {
		sections.push(
			"> [!CAUTION]",
			`> **${open.length === 1 ? "A name" : `${open.length} names`} your alerts or dashboards read stop${open.length === 1 ? "s" : ""} arriving after this ships.**${options.blocking ? " This check fails until each is kept or its readers are updated (repository setting)." : ""}`,
			...Arr.map(
				open,
				(item) =>
					`> - \`${item.name}\` (${KIND_LABEL[item.kind]}, ~${formatCount(item.perDay ?? 0)}/day): ${withText ? referenceList(item) : readerCount(item)}`,
			),
			"",
		)
	}
	const issues = groupIssues(telemetry.linkedIssues)
	if (issues.length > 0 && !withText) {
		const occurrences = Arr.reduce(issues, 0, (sum, issue) => sum + issue.occurrences)
		sections.push(
			`${issues.length} open error ${issues.length === 1 ? "group" : "groups"} in the changed files, ${formatCount(occurrences)} occurrences. Details are in Maple.`,
			"",
		)
	}
	if (issues.length > 0 && withText) {
		sections.push(
			`<details><summary>Open errors in the changed files (${issues.length})</summary>`,
			"",
			"| Issue | Service | Occurrences | File |",
			"| --- | --- | ---: | --- |",
			...Arr.map(
				issues,
				(issue) =>
					`| ${escapeCell(issue.title)}${issue.count > 1 ? ` (${issue.count} issues)` : ""} | ${escapeCell(issue.service)} | ${formatCount(issue.occurrences)} | \`${escapeCell(issue.path)}\` |`,
			),
			"",
			"After this merges, Maple checks whether they stop.",
			"",
			"</details>",
			"",
		)
	}
	if (options.brief === true) return sections.length === 0 ? [] : ["### Production impact", "", ...sections]
	if (telemetry.hotFiles.length > 0) {
		sections.push(
			`<details><summary>Production traffic of the changed files (last ${telemetry.windowDays} days)</summary>`,
			"",
			...(withText
				? ["| File | Calls/day | Busiest operations |", "| --- | ---: | --- |"]
				: ["| File | Calls/day |", "| --- | ---: |"]),
			...Arr.map(telemetry.hotFiles, (file) =>
				!withText
					? `| \`${escapeCell(file.path)}\` | ${formatCount(file.perDay)} |`
					: `| \`${escapeCell(file.path)}\` | ${formatCount(file.perDay)} | ${Arr.join(
							Arr.map(
								file.operations.slice(0, 3),
								(operation) =>
									`\`${escapeCell(operation.spanName)}\` ${formatCount(operation.perDay)}/day, ${(operation.errorRate * 100).toFixed(1)}% err`,
							),
							"<br>",
						)} |`,
			),
			"",
			"</details>",
			"",
		)
	}
	const changes = [
		...Arr.map(
			telemetry.removed,
			(item) =>
				`- ➖ ${KIND_LABEL[item.kind]} \`${item.name}\`${item.perDay === undefined ? "" : ` (~${formatCount(item.perDay)}/day today)`} · \`${item.path}:${item.line}\``,
		),
		...Arr.map(
			telemetry.added,
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
						...Arr.map(
							dismissed,
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
	const costs = Arr.filter(telemetry.costNotes, (note) => note.kind === "log")
	if (costs.length > 0) {
		sections.push(
			"<details><summary>Ingest cost of new log lines</summary>",
			"",
			...Arr.map(costs, (note) => `- \`${note.path}:${note.line}\`: ${note.note}`),
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
	const breaking = new Set(Arr.map(openContractBreaks(telemetry), (item) => item.name))
	return Arr.filter(open, (finding) => {
		const name = finding.category === "observability" ? BREAK_TITLE.exec(finding.title)?.[1] : undefined
		return name !== undefined && !breaking.has(name)
	})
}
