import type { SpanNode } from "@maple/query-engine/observability"
import type { InspectTraceOutput, SpanNodeOutput } from "@maple/domain/mcp-outputs"
import { formatDurationFromMs, truncate } from "./format"
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
}

type Output = typeof InspectTraceOutput.Type

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
	}
}

const renderTree = (output: Output): string => {
	const omittedByParent = new Map(output.omitted.map((entry) => [entry.parentSpanId, entry]))
	const lines: Array<string> = []
	const renderNode = (node: SpanNodeOutput, prefix: string, isLast: boolean): void => {
		const connector = prefix === "" ? "" : isLast ? "└── " : "├── "
		const status = node.statusCode === "Error" ? " [Error]" : node.statusCode === "Ok" ? " [Ok]" : ""
		// Full span id at the END of the line: readable label first, copyable id
		// last for `inspect_span` / `search_logs` follow-ups.
		lines.push(
			`${prefix}${connector}${node.spanName} — ${node.serviceName} (${formatDurationFromMs(node.durationMs)})${status}  span=${node.spanId}`,
		)
		const detailPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "│   ")
		if (node.statusCode === "Error" && node.statusMessage) {
			lines.push(`${detailPrefix}    Status: "${truncate(node.statusMessage, 100)}"`)
		}
		const attrs = Object.entries(node.attributes).slice(0, 5)
		if (attrs.length > 0) {
			lines.push(`${detailPrefix}    {${attrs.map(([k, v]) => `${k}=${truncate(v, 60)}`).join(", ")}}`)
		}
		const resourceAttrs = Object.entries(node.resourceAttributes).slice(0, 5)
		if (resourceAttrs.length > 0) {
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
			const spanRef = log.spanId ? ` span:${log.spanId.slice(0, 8)}` : ""
			return `${marker} ${time} [${log.severityText.padEnd(5)}] ${log.serviceName}: ${truncate(log.body, 100)}${spanRef}`
		}),
	].join("\n")

const collectServices = (node: SpanNodeOutput): Array<string> => [
	node.serviceName,
	...node.children.flatMap(collectServices),
]

const hasErrorSpan = (node: SpanNodeOutput): boolean =>
	node.statusCode === "Error" || node.children.some(hasErrorSpan)

/**
 * The trace as a bounded span tree (+ related logs). Pure, from the output alone, so the exact
 * text (span-id suffixes, the "Showing N of M" note, `… +K more` markers) is unit-testable.
 */
export function renderTraceOverview(output: Output): ToolDoc {
	if (output.spanCount === 0) {
		return {
			title: `Trace ${output.traceId}`,
			blocks: [],
			empty: {
				message: `No spans found for trace ${output.traceId}${output.timestamp === undefined ? " (scanned last 24h)" : ` within an hour of ${output.timestamp}`}.`,
				hints:
					output.timestamp === undefined
						? ["If this trace is older, pass timestamp from `search_traces` results."]
						: ["Check the trace id, or pass a timestamp from one of the trace's own spans."],
			},
		}
	}
	const truncated = output.truncated === true
	const policy = output.errorsOnly ? "error spans and their ancestors only" : "errors and longest first"
	const blocks: Array<DocBlock> = [doc.text(renderTree(output))]
	if (truncated) {
		blocks.push(
			doc.text(
				"Collapsed spans show as `… +K more`. Use `inspect_span` with a `span=` id for one span's full attributes, or `search_traces` to find more.",
			),
		)
	}
	if (output.logs.length > 0) blocks.push(doc.text(renderLogs(output.logs)))
	const services = [...new Set(output.spans.flatMap(collectServices))]
	return {
		title: `Trace ${output.traceId} (${output.serviceCount} services, ${output.spanCount} spans, ${formatDurationFromMs(output.rootDurationMs)})`,
		...(output.timestamp === undefined ? undefined : { scope: [["Around", output.timestamp]] }),
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
			...(output.spans.some(hasErrorSpan)
				? [doc.next("search_logs", { trace_id: output.traceId }, "see all logs for this trace")]
				: []),
			...services
				.slice(0, 2)
				.map((service) => doc.next("diagnose_service", { service }, "investigate this service")),
		],
	}
}
