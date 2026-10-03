import type { SpanNode } from "@maple/query-engine/observability"
import type { InspectTraceOutput, SpanNodeOutput } from "@maple/domain/mcp-outputs"
import { formatDurationFromMs, toSecondTimestamp, truncate } from "./format"
import { selectOverviewSpans, type OverviewOptions } from "./span-tree"
import { doc, type DocBlock, type ToolDoc } from "./tool-doc"

export interface TraceOverviewLog {
	readonly timestamp: string
	readonly severityText: string
	readonly serviceName: string
	readonly body: string
	readonly spanId: string
}

export interface TraceOverviewInput {
	readonly traceId: string
	readonly serviceCount: number
	readonly spanCount: number
	readonly rootDurationMs: number
	readonly spans: ReadonlyArray<SpanNode>
	readonly logs: ReadonlyArray<TraceOverviewLog>
	/** Max spans to render before collapsing the rest (see `selectOverviewSpans`). */
	readonly budget: number
	readonly options?: OverviewOptions
	/** The `timestamp` hint the scan was narrowed around, echoed for follow-up calls. */
	readonly timestamp?: string
	readonly scanned?: Output["scanned"]
}

type Output = typeof InspectTraceOutput.Type
type Rollup = NonNullable<Output["rollup"]>[number]

const ROLLUP_ROWS = 15

/** Per (span name, service) totals over every span, longest total first. */
export function rollupSpanNames(roots: ReadonlyArray<SpanNode>): Array<Rollup> {
	const byKey = new Map<string, Rollup>()
	const stack = [...roots]
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		stack.push(...node.children)
		const key = `${node.serviceName}\u0000${node.spanName}`
		const prev = byKey.get(key)
		byKey.set(key, {
			spanName: node.spanName,
			serviceName: node.serviceName,
			count: (prev?.count ?? 0) + 1,
			totalDurationMs: (prev?.totalDurationMs ?? 0) + node.durationMs,
			maxDurationMs: Math.max(prev?.maxDurationMs ?? 0, node.durationMs),
			errorCount: (prev?.errorCount ?? 0) + (node.statusCode === "Error" ? 1 : 0),
		})
	}
	return [...byKey.values()].sort((a, b) => b.totalDurationMs - a.totalDurationMs).slice(0, ROLLUP_ROWS)
}

/**
 * Bound a trace to its overview: the output mirrors the rendered tree, not the full
 * (up to 5_000-span) tree, which keeps the response bounded.
 */
export function buildTraceOverview(input: TraceOverviewInput): Output {
	const overview = selectOverviewSpans(input.spans, input.budget, input.options)
	return {
		traceId: input.traceId,
		serviceCount: input.serviceCount,
		spanCount: input.spanCount,
		rootDurationMs: input.rootDurationMs,
		spans: overview.roots,
		renderedSpanCount: overview.renderedCount,
		totalSpanCount: overview.totalCount,
		truncated: overview.truncated,
		logs: input.logs,
		omitted: [...overview.omittedByParent].map(([parentSpanId, omitted]) => ({
			parentSpanId,
			...omitted,
		})),
		errorsOnly: input.options?.errorsOnly === true,
		...(input.timestamp === undefined ? undefined : { timestamp: input.timestamp }),
		...(input.scanned === undefined ? undefined : { scanned: input.scanned }),
		...(overview.truncated ? { rollup: rollupSpanNames(input.spans) } : undefined),
	}
}

const renderTree = (output: Output): string => {
	const omittedByParent = new Map(output.omitted.map((entry) => [entry.parentSpanId, entry]))
	const lines: Array<string> = []
	// Resource attributes are per service; print them once, on its first span.
	const servicesWithResource = new Set<string>()
	const renderNode = (node: SpanNodeOutput, prefix: string, isLast: boolean): void => {
		const connector = prefix === "" ? "" : isLast ? "└── " : "├── "
		const status = node.statusCode === "Error" ? " [Error]" : node.statusCode === "Ok" ? " [Ok]" : ""
		// Full span id at the END of the line: readable label first, copyable id
		// last for `inspect_span` / `search_logs` follow-ups.
		lines.push(
			`${prefix}${connector}${node.spanName} — ${node.serviceName} (${formatDurationFromMs(node.durationMs)})${status}  span=${node.spanId}`,
		)
		const detailPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "│   ")
		// Filters match the stored name, not the display rewrite. A 0 duration on a
		// parent is what the SDK reported (e.g. a frozen clock), not a render bug.
		const notes = [
			...(node.rawSpanName === undefined ? [] : [`span_name="${node.rawSpanName}"`]),
			...(node.durationMs === 0 && node.children.length > 0 ? ["duration not recorded"] : []),
		]
		if (notes.length > 0) lines.push(`${detailPrefix}    ${notes.join(", ")}`)
		if (node.statusCode === "Error" && node.statusMessage) {
			lines.push(`${detailPrefix}    Status: "${truncate(node.statusMessage, 100)}"`)
		}
		const attrs = Object.entries(node.attributes).slice(0, 5)
		if (attrs.length > 0) {
			lines.push(`${detailPrefix}    {${attrs.map(([k, v]) => `${k}=${truncate(v, 60)}`).join(", ")}}`)
		}
		const resourceAttrs = servicesWithResource.has(node.serviceName)
			? []
			: Object.entries(node.resourceAttributes).slice(0, 5)
		if (resourceAttrs.length > 0) {
			servicesWithResource.add(node.serviceName)
			lines.push(
				`${detailPrefix}    resource: {${resourceAttrs.map(([k, v]) => `${k}=${truncate(v, 60)}`).join(", ")}}`,
			)
		}
		const omitted = omittedByParent.get(node.spanId)
		node.children.forEach((child, i) => {
			renderNode(child, detailPrefix, i === node.children.length - 1 && omitted === undefined)
		})
		if (omitted !== undefined) {
			const omittedConnector = detailPrefix === "" ? "" : "└── "
			const label = omitted.count === 1 ? "span" : "spans"
			lines.push(
				`${detailPrefix}${omittedConnector}… +${omitted.count} more ${label} (${formatDurationFromMs(omitted.totalDurationMs)} total)`,
			)
		}
	}
	output.spans.forEach((root) => renderNode(root, "", true))
	return lines.join("\n")
}

const renderLogs = (logs: Output["logs"]): string =>
	[
		`Related Logs (${logs.length}):`,
		...logs.map((log) => {
			const time = log.timestamp.split(" ")[1] ?? log.timestamp
			const sevUpper = log.severityText.toUpperCase()
			const marker = sevUpper === "ERROR" || sevUpper === "FATAL" ? "●" : " "
			const spanRef = log.spanId ? ` span=${log.spanId}` : ""
			return `${marker} ${time} [${log.severityText.padEnd(5)}] ${log.serviceName}: ${truncate(log.body, 100)}${spanRef}`
		}),
	].join("\n")

const collectServices = (node: SpanNodeOutput): Array<string> => [
	node.serviceName,
	...node.children.flatMap(collectServices),
]

const findFirstError = (nodes: ReadonlyArray<SpanNodeOutput>): SpanNodeOutput | undefined => {
	for (const node of nodes) {
		const hit = node.statusCode === "Error" ? node : findFirstError(node.children)
		if (hit !== undefined) return hit
	}
	return undefined
}

const hasErrorSpan = (node: SpanNodeOutput): boolean =>
	node.statusCode === "Error" || node.children.some(hasErrorSpan)

/**
 * The trace as a bounded span tree (+ related logs). Pure, from the output alone, so the exact
 * text (span-id suffixes, the "Showing N of M" note, `… +K more` markers) is unit-testable.
 */
export function renderTraceOverview(output: Output): ToolDoc {
	if (output.spanCount === 0) {
		const scanned = output.scanned
		const where =
			scanned !== undefined
				? ` (scanned ${scanned.startTime} to ${scanned.endTime}${scanned.widened ? ", widened past the first window" : ""})`
				: output.timestamp === undefined
					? " (scanned last 24h)"
					: ` within an hour of ${output.timestamp}`
		return {
			title: `Trace ${output.traceId}`,
			blocks: [],
			empty: {
				message: `No spans found for trace ${output.traceId}${where}.`,
				hints: [
					"Check the trace id is a full 32-hex trace id, not a span id or a prefix.",
					"For an older trace, pass `timestamp` from a search_traces row's Start column.",
				],
			},
		}
	}
	const truncated = output.truncated === true
	const policy = output.errorsOnly ? "error spans and their ancestors only" : "errors and longest first"
	const blocks: Array<DocBlock> = [doc.text(renderTree(output))]
	blocks.push(
		doc.text(
			truncated
				? "Collapsed spans show as `… +K more`. Lines show a trimmed attribute set: `inspect_span` with a `span=` id lists every attribute; `search_traces` finds more."
				: "Lines show a trimmed attribute set: `inspect_span` with a `span=` id lists every attribute.",
		),
	)
	if (output.rollup !== undefined && output.rollup.length > 0) {
		blocks.push(
			doc.heading(`Span names across all ${output.spanCount} spans (by total time)`),
			doc.table(
				["Span Name", "Service", "Count", "Total", "Max", "Errors"],
				output.rollup.map((r) => [
					r.spanName,
					r.serviceName,
					String(r.count),
					formatDurationFromMs(r.totalDurationMs),
					formatDurationFromMs(r.maxDurationMs),
					r.errorCount === 0 ? "" : String(r.errorCount),
				]),
			),
		)
	}
	if (output.logs.length > 0) blocks.push(doc.text(renderLogs(output.logs)))
	const services = [...new Set(output.spans.flatMap(collectServices))]
	const focus = findFirstError(output.spans) ?? output.spans[0]
	return {
		title: `Trace ${output.traceId} (${output.serviceCount} services, ${output.spanCount} spans, ${formatDurationFromMs(output.rootDurationMs)})`,
		scope: [
			["Around", output.timestamp],
			[
				"Scanned",
				output.scanned?.widened === true
					? `${output.scanned.startTime} to ${output.scanned.endTime} (widened)`
					: undefined,
			],
		],
		blocks,
		...(truncated
			? {
					truncation: {
						shown: output.renderedSpanCount ?? output.spanCount,
						total: output.spanCount,
						noun: `spans (${policy})`,
					},
				}
			: undefined),
		next: [
			...(focus === undefined
				? []
				: [
						doc.next(
							"inspect_span",
							{
								trace_id: output.traceId,
								span_id: focus.spanId,
								timestamp:
									focus.startTime === undefined
										? undefined
										: toSecondTimestamp(focus.startTime),
							},
							focus.statusCode === "Error"
								? "every attribute of the first error span"
								: "every attribute of the root span",
						),
					]),
			...(output.spans.some(hasErrorSpan)
				? [doc.next("search_logs", { trace_id: output.traceId }, "see all logs for this trace")]
				: []),
			...services
				.slice(0, 2)
				.map((service) => doc.next("diagnose_service", { service }, "investigate this service")),
		],
	}
}
