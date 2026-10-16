import { createElement, lazy, memo, Suspense, useMemo } from "react"
import { CircleXmarkIcon } from "@/components/icons"
import { Spinner } from "@maple/ui/components/ui/spinner"
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceDescription,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@maple/ui/components/ui/trace"
import type { StructuredToolOutput } from "@maple/domain"
import { STRUCTURED_MARKER } from "./renderers/constants"
import { DotLoader } from "./dot-loader"
import { toolActivity, toolIcon, toolLabel } from "./tool-metadata"
import { formatElapsed, useElapsedSeconds } from "@/hooks/use-elapsed-seconds"

export { normalizeToolName, toolLabel } from "./tool-metadata"

const LazyToolRenderer = lazy(() =>
	import("./renderers/tool-renderer").then((m) => ({
		default: m.ToolRenderer,
	})),
)

// Status helpers

type ToolStatus = "running" | "completed" | "error"

function deriveStatus(state: string): ToolStatus {
	switch (state) {
		case "output-available":
			return "completed"
		case "output-error":
		case "output-denied":
			return "error"
		default:
			return "running"
	}
}

/**
 * The row's leading glyph: the tool's own icon once it has settled, so a burst of a dozen rows
 * scans by shape, and the call's state while it runs or after it fails.
 *
 * Only a `live` row (the trailing edge of a streaming turn, with nothing after it) gets a
 * dot-matrix loader. Rows inside a `ToolGroup` are detail behind a header that already carries
 * one, and an expanded twelve-call burst would otherwise be twelve grids animating at once.
 */
function StatusGlyph({ status, live, toolName }: { status: ToolStatus; live: boolean; toolName: string }) {
	if (status === "running") {
		return live ? (
			<DotLoader />
		) : (
			<Spinner className="size-3.5 text-muted-foreground motion-reduce:animate-none" />
		)
	}
	if (status === "error") return <CircleXmarkIcon className="size-3.5" />
	return createElement(toolIcon(toolName), { className: "size-3.5" })
}

const SUMMARY_KEYS = [
	"service",
	"serviceName",
	"query",
	"q",
	"traceId",
	"spanId",
	"name",
	"metric",
	"errorId",
	"issueId",
	"dashboardId",
	"ruleId",
]

// Boilerplate args present on nearly every Maple tool — never use them as the summary.
const SUMMARY_EXCLUDE = new Set([
	"start_time",
	"end_time",
	"startTime",
	"endTime",
	"limit",
	"offset",
	"interval",
	"granularity",
	"org_id",
	"orgId",
])

function truncate(value: string, max = 40): string {
	const trimmed = value.trim()
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function toolSummary(input: unknown): string | undefined {
	if (input == null || typeof input !== "object") return undefined
	const obj = input as Record<string, unknown>
	const format = (key: string, value: unknown): string | undefined => {
		if (typeof value === "string" && value.trim()) return `${key}=${truncate(value)}`
		if (typeof value === "number" || typeof value === "boolean") return `${key}=${value}`
		return undefined
	}
	for (const key of SUMMARY_KEYS) {
		const formatted = format(key, obj[key])
		if (formatted) return formatted
	}
	for (const [key, value] of Object.entries(obj)) {
		if (SUMMARY_EXCLUDE.has(key)) continue
		const formatted = format(key, value)
		if (formatted) return formatted
	}
	return undefined
}

const isStructured = (value: unknown): value is StructuredToolOutput =>
	value != null && typeof value === "object" && STRUCTURED_MARKER in value

/**
 * Recover the rich payload a Maple tool renders as a table, chart or tree.
 *
 * Tool results arrive as `{ text, ui? }` — the chat agent's MCP adapter
 * (`apps/api/src/chat/`) splits the report text from the `__maple_ui` payload. The legacy shapes below are the
 * two the runtime produced before tool results could be structured JSON: a raw
 * MCP `{ content: [...] }` object, and a string with the UI JSON concatenated
 * onto the report. Both still exist in conversations recorded earlier, and a
 * replayed thread should keep rendering the way it did when it was live.
 */
export function extractStructuredData(output: unknown): StructuredToolOutput | null {
	if (output == null) return null

	if (typeof output === "object" && "ui" in (output as Record<string, unknown>)) {
		const ui = (output as { ui: unknown }).ui
		return isStructured(ui) ? ui : null
	}

	if (typeof output === "string") return parseStructuredFromText(output)

	if (typeof output === "object" && "content" in (output as Record<string, unknown>)) {
		const content = (output as { content: unknown[] }).content
		if (!Array.isArray(content)) return null
		for (const item of content) {
			const text = textOf(item)
			if (text === null) continue
			const parsed = parseStructuredFromText(text)
			if (parsed) return parsed
		}
	}
	return null
}

const textOf = (item: unknown): string | null =>
	typeof item === "object" &&
	item != null &&
	"type" in item &&
	(item as { type: string }).type === "text" &&
	"text" in item
		? (item as { text: string }).text
		: null

const MARKER_PREFIX = `{"${STRUCTURED_MARKER}":true`

/**
 * Where a legacy joined string's UI blob starts. It was always the last block, but the join was
 * a single newline for a while, so it can sit on the same paragraph as the report's last line.
 */
const markerStart = (text: string): number => {
	const index = text.lastIndexOf(MARKER_PREFIX)
	return index > 0 && text[index - 1] !== "\n" ? -1 : index
}

/** A JSON blob carrying the UI marker, at the end of a joined string. */
function parseStructuredFromText(text: string): StructuredToolOutput | null {
	const start = markerStart(text)
	if (start === -1) return null
	try {
		const parsed: unknown = JSON.parse(text.slice(start).trim())
		return isStructured(parsed) ? parsed : null
	} catch {
		// Not JSON (or cut off by truncation): ordinary report text.
		return null
	}
}

export function extractOutputText(output: unknown): string | null {
	if (output == null) return null

	if (typeof output === "object" && "text" in (output as Record<string, unknown>)) {
		const text = (output as { text: unknown }).text
		if (typeof text === "string") return text
	}

	if (typeof output === "string") return stripStructuredChunks(output)

	// Legacy MCP shape: { content: [{ type: "text", text: "..." }] }
	if (typeof output === "object" && "content" in (output as Record<string, unknown>)) {
		const content = (output as { content: unknown[] }).content
		if (Array.isArray(content)) {
			return content
				.map(textOf)
				.filter((text): text is string => text !== null && parseStructuredFromText(text) === null)
				.join("\n")
		}
	}

	return JSON.stringify(output, null, 2)
}

/** Drop the UI payload from a legacy joined string so it isn't shown as raw JSON. */
const stripStructuredChunks = (text: string): string => {
	const start = markerStart(text)
	return start === -1 ? text : text.slice(0, start).trimEnd()
}

// Component

interface ToolProps {
	toolName: string
	toolCallId: string
	state: string
	input?: unknown
	output?: unknown
	errorText?: string
	/** This row is the turn's live edge, so its running state is the dot matrix and a running
	 *  clock rather than a quiet spinner. */
	live?: boolean
}

/**
 * One tool call, as a single quiet line: status glyph, what the call is (or was) doing, its
 * most salient argument, and an inline-expandable detail panel.
 *
 * Deliberately not a card. A Maple turn routinely makes a dozen calls, and at ~40px of bordered,
 * filled panel apiece the plumbing outweighed the answer it was there to support — the reader
 * scrolled past tool chrome to find two paragraphs of prose. A line is ~24px, carries the same
 * four facts, and still opens to the full arguments and result.
 */
export const ToolRow = memo(function ToolRow(props: ToolProps) {
	const { toolName, state, input, output, errorText, live = false } = props
	const status = deriveStatus(state)
	// A call in flight is described by what it is doing; a settled one by what it did.
	const label = status === "running" ? toolActivity(toolName) : toolLabel(toolName)
	const summary = useMemo(() => toolSummary(input), [input])

	const hasInput =
		input != null && typeof input === "object" && Object.keys(input as Record<string, unknown>).length > 0
	// Both walk the output, `split("\n\n")` it and `JSON.parse` every `{`-prefixed chunk. A settled
	// tool result never changes, so they are memoised: Maple's tool outputs are warehouse rows and
	// trace payloads, and re-parsing them was the most expensive thing a streamed token triggered.
	const structuredData = useMemo(() => extractStructuredData(output), [output])
	const outputText = useMemo(() => extractOutputText(output), [output])
	const hasContent = hasInput || structuredData != null || outputText != null || errorText != null

	const line = (
		<TraceLine status={status === "completed" ? undefined : status}>
			<TraceIcon className={live ? "size-5" : undefined}>
				<StatusGlyph status={status} live={live} toolName={toolName} />
			</TraceIcon>
			<TraceTitle className="font-medium" title={label}>
				{label}
			</TraceTitle>
			{summary ? (
				<TraceDescription className="min-w-0 shrink truncate font-mono text-2xs text-muted-foreground/60">
					{summary}
				</TraceDescription>
			) : null}
			{status === "running" && live ? <RunningClock /> : null}
		</TraceLine>
	)

	if (!hasContent) return line

	// Panel content is unmounted while closed, so the lazy renderer chunk only loads on first open.
	return (
		<TraceCollapsible>
			<TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="space-y-2 text-xs">
				{hasInput && (
					<div>
						<p className="mb-1 font-medium">Arguments</p>
						<div className="max-h-60 space-y-0.5 overflow-auto">
							{Object.entries(input as Record<string, unknown>)
								.filter(([, v]) => v != null)
								.map(([key, value]) => (
									<div key={key} className="flex gap-2">
										<span className="shrink-0">{key}:</span>
										<span className="min-w-0 font-mono break-all whitespace-pre-wrap text-foreground">
											{typeof value === "string" ? value : JSON.stringify(value)}
										</span>
									</div>
								))}
						</div>
					</div>
				)}

				{errorText != null && (
					<div>
						<p className="mb-1 font-medium text-severity-error">Error</p>
						<pre className="max-h-40 overflow-auto whitespace-pre-wrap text-severity-error/80">
							{errorText}
						</pre>
					</div>
				)}

				{structuredData ? (
					<div className="text-foreground">
						<Suspense fallback={<Spinner className="size-3.5 text-muted-foreground" />}>
							<LazyToolRenderer data={structuredData} />
						</Suspense>
					</div>
				) : outputText != null ? (
					<div>
						<p className="mb-1 font-medium">Result</p>
						<pre className="max-h-80 overflow-auto whitespace-pre-wrap">{outputText}</pre>
					</div>
				) : null}
			</TraceCollapsibleContent>
		</TraceCollapsible>
	)
})

/**
 * How long the call in flight has been running. Silent for the first couple of seconds — most
 * Maple tools answer inside one, and a counter that flashes `1s` and vanishes is noise. Past
 * that it is the difference between "querying the warehouse" and "wedged".
 */
export function RunningClock() {
	const elapsed = formatElapsed(useElapsedSeconds())
	if (!elapsed) return null
	return <span className="shrink-0 tabular-nums text-2xs text-muted-foreground/60">{elapsed}</span>
}

/** A tool call standing on its own, in a `Trace` list of one. */
export const Tool = memo(function Tool(props: ToolProps) {
	return (
		<Trace>
			<ToolRow {...props} />
		</Trace>
	)
})
