/**
 * A pull request's diff read against the organization's telemetry: what it stops emitting that
 * someone reads, which production operations it touches, which open errors live in its files, and
 * what its new logs cost. Pure, so the same inputs always give the same facts.
 */
import {
	PrReviewContractBreak,
	PrReviewCostNote,
	PrReviewHotFile,
	PrReviewLinkedIssue,
	PrReviewOperationTraffic,
	PrReviewTelemetry,
	PrReviewTelemetryChange,
	type PrReviewTelemetryKind,
	type PullRequestFile,
} from "@maple/domain/http"
import { type DiffLine, emittedNames, isLogCall, isRuntimeSource, literalsOf, parsePatch } from "./diff"
import { referencesFor, type ReferenceSource } from "./references"

/** One production operation over the catalog window. */
export interface CatalogOperation {
	readonly service: string
	readonly spanName: string
	readonly count: number
	readonly errorCount: number
	readonly p95Ms: number
}

/** What the organization emitted over the last `windowDays`. */
export interface TelemetryCatalog {
	readonly windowDays: number
	readonly operations: ReadonlyArray<CatalogOperation>
	/** Span and resource attribute keys, with how often each was set. */
	readonly attributeKeys: ReadonlyMap<string, number>
	/** Metric names, with how many data points each wrote. */
	readonly metricNames: ReadonlyMap<string, number>
	/** The organization's average log record size, for cost estimates. */
	readonly bytesPerLogRecord: number
}

export interface CatalogIssue {
	readonly id: string
	readonly fingerprintHash: string
	readonly title: string
	readonly service: string
	readonly topFrame: string
	readonly occurrences: number
	readonly lastSeenAt: number
}

/** Used when the organization has sent no logs to average over. */
export const DEFAULT_BYTES_PER_LOG_RECORD = 500

export const EMPTY_CATALOG: TelemetryCatalog = {
	windowDays: 7,
	operations: [],
	attributeKeys: new Map(),
	metricNames: new Map(),
	bytesPerLogRecord: DEFAULT_BYTES_PER_LOG_RECORD,
}

const MAX_BREAKS = 20
const MAX_HOT_FILES = 15
const MAX_OPERATIONS_PER_FILE = 5
const MAX_ISSUES = 10
const MAX_COST_NOTES = 10
const MAX_CHANGES = 30
/** A log line is worth a note when it would ingest at least this much a month. */
const COST_NOTE_MIN_GB = 0.1

/** File names too common to tie a stack frame to one changed file on their own. */
const GENERIC_BASENAME =
	/^(index|main|app|server|worker|handler|handlers|utils?|helpers?|mod|lib|types|routes?|api|client|service|init|__init__)$/i

const stripExtension = (name: string) => name.replace(/\.[^.]+$/, "")

/**
 * Whether a normalized top frame points at a changed file: by its last directory and name (any
 * extension, since a frame may be the compiled `.js` of a `.ts` file), or by a distinctive name
 * alone.
 */
export const frameMatchesPath = (frame: string, path: string): boolean => {
	const haystack = frame.toLowerCase().replace(/\\/g, "/")
	const segments = path.toLowerCase().split("/")
	const name = stripExtension(segments.at(-1) ?? "")
	if (name.length === 0) return false
	const dir = segments.at(-2)
	if (dir !== undefined && haystack.includes(`${dir}/${name}.`)) return true
	return !GENERIC_BASENAME.test(name) && name.length >= 6 && new RegExp(`[/\\s(@]${name}\\.`).test(haystack)
}

const perDay = (count: number, windowDays: number) => Math.round(count / Math.max(1, windowDays))

/** The operations a literal names: a span name exactly, or a route (`/checkout`) inside `POST /checkout`. */
const operationsNamed = (value: string, operations: ReadonlyArray<CatalogOperation>) =>
	operations.filter(
		(operation) =>
			operation.spanName === value ||
			(value.startsWith("/") && value.length > 1 && operation.spanName.endsWith(` ${value}`)),
	)

export interface AnalyzeTelemetryInput {
	readonly files: ReadonlyArray<PullRequestFile>
	readonly catalog: TelemetryCatalog
	readonly sources: ReadonlyArray<ReferenceSource>
	readonly issues: ReadonlyArray<CatalogIssue>
}

export const analyzeTelemetry = (input: AnalyzeTelemetryInput): PrReviewTelemetry => {
	const { catalog } = input
	const spanCounts = new Map<string, number>()
	for (const operation of catalog.operations) {
		spanCounts.set(operation.spanName, (spanCounts.get(operation.spanName) ?? 0) + operation.count)
	}
	const kindOf = (value: string): { kind: PrReviewTelemetryKind; count: number } | undefined => {
		const span = spanCounts.get(value)
		if (span !== undefined) return { kind: "span", count: span }
		const attribute = catalog.attributeKeys.get(value)
		if (attribute !== undefined) return { kind: "attribute", count: attribute }
		const metric = catalog.metricNames.get(value)
		if (metric !== undefined) return { kind: "metric", count: metric }
		return undefined
	}

	const files = input.files
		.filter((file) => isRuntimeSource(file.path) && file.patch !== null)
		.map((file) => ({ path: file.path, lines: parsePatch(file.patch) }))

	// A name added anywhere in the pull request is moved, not removed.
	const addedValues = new Set<string>()
	const removedValues = new Set<string>()
	for (const file of files) {
		for (const line of file.lines) {
			const target = line.kind === "add" ? addedValues : line.kind === "del" ? removedValues : undefined
			if (target === undefined) continue
			for (const literal of literalsOf(line.text)) target.add(literal.value)
		}
	}

	const removed: Array<PrReviewTelemetryChange> = []
	const breaks: Array<PrReviewContractBreak> = []
	const seenRemoved = new Set<string>()
	for (const file of files) {
		for (const line of file.lines) {
			if (line.kind !== "del") continue
			for (const literal of literalsOf(line.text)) {
				if (literal.templated || addedValues.has(literal.value) || seenRemoved.has(literal.value)) continue
				const known = kindOf(literal.value)
				if (known === undefined) continue
				seenRemoved.add(literal.value)
				const daily = perDay(known.count, catalog.windowDays)
				removed.push(
					new PrReviewTelemetryChange({
						kind: known.kind,
						name: literal.value,
						path: file.path,
						line: line.newLine,
						perDay: daily,
					}),
				)
				const references = referencesFor(literal.value, input.sources)
				if (references.length > 0) {
					breaks.push(
						new PrReviewContractBreak({
							kind: known.kind,
							name: literal.value,
							path: file.path,
							line: line.newLine,
							references,
							perDay: daily,
						}),
					)
				}
			}
		}
	}

	const added: Array<PrReviewTelemetryChange> = []
	const seenAdded = new Set<string>()
	const costNotes: Array<PrReviewCostNote> = []
	const hotFiles: Array<PrReviewHotFile> = []
	for (const file of files) {
		const operations = new Map<string, CatalogOperation>()
		for (const line of file.lines) {
			for (const literal of literalsOf(line.text)) {
				for (const operation of operationsNamed(literal.value, catalog.operations)) {
					operations.set(`${operation.service}\u0000${operation.spanName}`, operation)
				}
			}
		}
		const traffic = [...operations.values()]
			.map(
				(operation) =>
					new PrReviewOperationTraffic({
						service: operation.service,
						spanName: operation.spanName,
						perDay: perDay(operation.count, catalog.windowDays),
						errorRate: operation.count === 0 ? 0 : operation.errorCount / operation.count,
						p95Ms: Math.round(operation.p95Ms),
					}),
			)
			.filter((operation) => operation.perDay > 0)
			.sort((a, b) => b.perDay - a.perDay)
		const filePerDay = traffic.reduce((sum, operation) => sum + operation.perDay, 0)
		if (traffic.length > 0) {
			hotFiles.push(
				new PrReviewHotFile({
					path: file.path,
					perDay: filePerDay,
					operations: traffic.slice(0, MAX_OPERATIONS_PER_FILE),
				}),
			)
		}

		file.lines.forEach((line, index) => {
			if (line.kind !== "add") return
			const nearby = nearbyText(file.lines, index)
			for (const name of emittedNames(line.text, nearby)) {
				if (name.templated) {
					if (name.kind === "span") costNotes.push(templatedSpanNote(file.path, line.newLine, name.value))
					continue
				}
				if (seenAdded.has(name.value) || removedValues.has(name.value) || kindOf(name.value) !== undefined)
					continue
				seenAdded.add(name.value)
				added.push(
					new PrReviewTelemetryChange({ kind: name.kind, name: name.value, path: file.path, line: line.newLine }),
				)
			}
			if (filePerDay > 0 && isLogCall(line.text)) {
				const gbPerMonth = (filePerDay * 30 * catalog.bytesPerLogRecord) / 1e9
				if (gbPerMonth >= COST_NOTE_MIN_GB) {
					costNotes.push(
						new PrReviewCostNote({
							path: file.path,
							line: line.newLine,
							kind: "log",
							gbPerMonth: Math.round(gbPerMonth * 10) / 10,
							note: `If this logs once per call, about ${formatGb(gbPerMonth)}/month: the file's operations run ${formatCount(filePerDay)} times a day.`,
						}),
					)
				}
			}
		})
	}

	const linkedIssues = input.issues
		.flatMap((issue) => {
			const file = files.find((candidate) => frameMatchesPath(issue.topFrame, candidate.path))
			return file === undefined
				? []
				: [
						new PrReviewLinkedIssue({
							issueId: issue.id,
							fingerprintHash: issue.fingerprintHash,
							title: issue.title,
							service: issue.service,
							path: file.path,
							topFrame: issue.topFrame,
							occurrences: issue.occurrences,
							lastSeenAt: issue.lastSeenAt,
						}),
					]
		})
		.sort((a, b) => b.occurrences - a.occurrences)
		.slice(0, MAX_ISSUES)

	hotFiles.sort((a, b) => b.perDay - a.perDay)
	const services = [
		...new Set(hotFiles.flatMap((file) => file.operations.map((operation) => operation.service))),
	].slice(0, 10)

	return new PrReviewTelemetry({
		windowDays: catalog.windowDays,
		services,
		// Alerts first: a silent alert is worse than an empty chart.
		contractBreaks: breaks
			.sort(
				(a, b) =>
					Number(b.references.some((ref) => ref.kind === "alert")) -
						Number(a.references.some((ref) => ref.kind === "alert")) || (b.perDay ?? 0) - (a.perDay ?? 0),
			)
			.slice(0, MAX_BREAKS),
		hotFiles: hotFiles.slice(0, MAX_HOT_FILES),
		linkedIssues,
		costNotes: costNotes
			.sort((a, b) => (b.gbPerMonth ?? Number.POSITIVE_INFINITY) - (a.gbPerMonth ?? Number.POSITIVE_INFINITY))
			.slice(0, MAX_COST_NOTES),
		added: added.slice(0, MAX_CHANGES),
		removed: removed.slice(0, MAX_CHANGES),
	})
}

const nearbyText = (lines: ReadonlyArray<DiffLine>, index: number) =>
	lines
		.slice(Math.max(0, index - 4), index)
		.filter((line) => line.kind !== "del")
		.map((line) => line.text)
		.join("\n")

const templatedSpanNote = (path: string, line: number, value: string) =>
	new PrReviewCostNote({
		path,
		line,
		kind: "span_name",
		note: `The span name \`${value.slice(0, 80)}\` is built from a runtime value, so every value becomes its own operation: grouping, rollups and alerts by span name stop working. Keep the name fixed and put the value in an attribute.`,
	})

export const formatCount = (value: number): string =>
	value >= 1_000_000
		? `${(value / 1_000_000).toFixed(1)}M`
		: value >= 1_000
			? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
			: String(Math.round(value))

export const formatGb = (value: number): string =>
	value >= 10 ? `${Math.round(value)} GB` : value >= 1 ? `${value.toFixed(1)} GB` : `${Math.round(value * 1000)} MB`
