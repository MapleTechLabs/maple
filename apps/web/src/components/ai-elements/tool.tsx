import { lazy, memo, Suspense, useMemo, useState } from "react"
import { ChevronDownIcon, CircleCheckIcon, CircleXmarkIcon, LoaderIcon } from "@/components/icons"
import { cn } from "@maple/ui/lib/utils"
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
 * The row's 20px glyph column.
 *
 * Only a `live` row — the trailing edge of a streaming turn, with nothing after it — gets a
 * dot-matrix loader. Rows inside a `ToolGroup` are detail behind a header that already carries
 * one, and an expanded twelve-call burst would otherwise be twelve grids animating against
 * each other.
 *
 * The slot is a fixed box rather than a sized glyph, and the matrix draws in the same 14px box
 * as the check that replaces it, so the line does not move when a call settles.
 */
function StatusGlyph({ status, live }: { status: ToolStatus; live: boolean }) {
	const glyph =
		status === "running" ? (
			live ? (
				<DotLoader />
			) : (
				<LoaderIcon className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />
			)
		) : status === "error" ? (
			<CircleXmarkIcon className="size-3.5 text-destructive" />
		) : (
			<CircleCheckIcon className="size-3.5 text-severity-info" />
		)
	return (
		<span className={cn("flex shrink-0 items-center justify-center", live ? "size-5" : "size-4")}>
			{glyph}
		</span>
	)
}

// Pick the most salient input field for a one-line row summary, e.g. `service=api`.
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

/** A JSON blob carrying the UI marker, possibly one paragraph of a joined string. */
function parseStructuredFromText(text: string): StructuredToolOutput | null {
	for (const chunk of text.split("\n\n")) {
		const trimmed = chunk.trim()
		if (!trimmed.startsWith("{")) continue
		try {
			const parsed: unknown = JSON.parse(trimmed)
			if (isStructured(parsed)) return parsed
		} catch {
			// Not JSON — ordinary report text.
		}
	}
	return null
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
const stripStructuredChunks = (text: string): string =>
	text
		.split("\n\n")
		.filter((chunk) => parseStructuredFromText(chunk) === null)
		.join("\n\n")

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
	const Icon = toolIcon(toolName)
	const summary = useMemo(() => toolSummary(input), [input])

	const [open, setOpen] = useState(false)

	const hasInput =
		input != null && typeof input === "object" && Object.keys(input as Record<string, unknown>).length > 0
	// Both walk the output, `split("\n\n")` it and `JSON.parse` every `{`-prefixed chunk. A settled
	// tool result never changes, but this used to re-run on every render of the transcript — and
	// Maple's tool outputs are warehouse rows and trace payloads, so that was the single most
	// expensive thing a streamed token could trigger.
	const structuredData = useMemo(() => extractStructuredData(output), [output])
	const outputText = useMemo(() => extractOutputText(output), [output])
	const hasContent = hasInput || structuredData != null || outputText != null || errorText != null

	return (
		<div className="text-xs">
			<button
				type="button"
				className="group/tool flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
				disabled={!hasContent}
				onClick={() => setOpen((v) => !v)}
			>
				<StatusGlyph status={status} live={live} />
				{/* The tool icon differentiates rows when you're scanning a group of a dozen. A live
				    row has nothing to differentiate itself from, and next to the loader it was just a
				    second glyph competing with a finely-dotted one. */}
				{live ? null : <Icon className="size-3.5 shrink-0 text-muted-foreground/70" />}
				<span
					className={cn(
						"shrink-0 font-medium",
						status === "running" ? "shimmer text-foreground" : "text-muted-foreground",
					)}
				>
					{label}
				</span>
				{summary ? (
					<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/60">
						{summary}
					</span>
				) : (
					<span className="flex-1" />
				)}
				{status === "running" && live ? <RunningClock /> : null}
				{hasContent ? (
					<ChevronDownIcon
						className={cn(
							"size-3 shrink-0 text-muted-foreground/60 transition-transform",
							open ? "rotate-0" : "-rotate-90",
						)}
					/>
				) : null}
			</button>

			{open && hasContent && (
				<div className="ms-[0.9375rem] space-y-2 border-s border-border/60 py-1.5 ps-3">
					{hasInput && (
						<div>
							<p className="mb-1 font-medium text-muted-foreground">Arguments</p>
							<div className="space-y-0.5">
								{Object.entries(input as Record<string, unknown>)
									.filter(([, v]) => v != null)
									.map(([key, value]) => (
										<div key={key} className="flex gap-2">
											<span className="shrink-0 text-muted-foreground">{key}:</span>
											<span className="font-mono text-foreground">
												{typeof value === "string" ? value : JSON.stringify(value)}
											</span>
										</div>
									))}
							</div>
						</div>
					)}

					{errorText != null && (
						<div>
							<p className="mb-1 font-medium text-destructive">Error</p>
							<pre className="max-h-40 overflow-auto whitespace-pre-wrap text-destructive/80">
								{errorText}
							</pre>
						</div>
					)}

					{(structuredData || outputText != null) && (
						<div>
							{structuredData ? (
								<Suspense fallback={<div className="text-muted-foreground">Loading…</div>}>
									<LazyToolRenderer data={structuredData} />
								</Suspense>
							) : outputText != null ? (
								<>
									<p className="mb-1 font-medium text-muted-foreground">Result</p>
									<pre className="max-h-80 overflow-auto whitespace-pre-wrap text-muted-foreground">
										{outputText}
									</pre>
								</>
							) : null}
						</div>
					)}
				</div>
			)}
		</div>
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
	return <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/60">{elapsed}</span>
}

/** A tool call standing on its own — same line, no shell around it. */
export const Tool = memo(function Tool(props: ToolProps) {
	return <ToolRow {...props} />
})
