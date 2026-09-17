/**
 * What a running investigation is doing, written to its row as it goes.
 *
 * Before this the row said nothing between being opened and a report landing.
 * The page could show that a pass was running and for how long, and that was all
 * of it: every step the run took lived in the agent's event stream, behind a
 * different tab, and was gone the moment the run ended without one.
 *
 * The accumulation is here rather than in `InvestigationService` because this is
 * where the events are. A recorder holds the tail in memory and hands the
 * service a whole record on a heartbeat, so a hundred tool calls cost a handful
 * of writes. That matters more than it looks: `investigations` replicates with
 * REPLICA IDENTITY FULL, so every write ships the entire row, including the
 * subject, snapshot and report blobs.
 */
import { Option, Schema } from "effect"
import {
	INVESTIGATION_PROGRESS_STEPS,
	type InvestigationProgress,
	type InvestigationStep,
} from "@maple/domain/http"

/**
 * A tool call's arguments, once.
 *
 * `ChatToolCallEvent.input` is `Schema.Unknown` on the wire, because the union
 * of ~47 tools' parameter schemas is not a type worth writing and no consumer
 * has ever needed one. This is the parse that makes it a value: an open record,
 * decoded at the one place a tool call enters this module, so nothing below has
 * to take `unknown` and guess.
 */
export const ToolCallInput = Schema.Record(Schema.String, Schema.Unknown)
export type ToolCallInput = Schema.Schema.Type<typeof ToolCallInput>

const decode = Schema.decodeUnknownOption(ToolCallInput)

/** A tool call's arguments, or an empty record when they are not one. */
export const parseToolInput = (input: unknown): ToolCallInput => Option.getOrElse(decode(input), () => ({}))

/** How long a step may sit in memory before it is worth a write. */
export const PROGRESS_HEARTBEAT_MS = 8_000

/** Longest argument fragment a label will carry. */
const ARG_MAX = 32

/**
 * Input keys worth naming in a label, most specific first.
 *
 * A generic "Search logs" says the run is alive; "Search logs in checkout-api"
 * says what it is thinking about, which is the only reason to watch a feed at
 * all. The order is the order a reader would want them, not the order tools
 * declare them.
 */
const SALIENT_KEYS = [
	"trace_id",
	"fingerprint",
	"issue_id",
	"pattern",
	"query",
	"service_name",
	"service",
	"path",
	"sql",
] as const

const asText = (value: unknown): string | null => {
	if (typeof value === "string") return value.trim() || null
	if (typeof value === "number" || typeof value === "boolean") return String(value)
	return null
}

const clamp = (value: string): string => {
	const line = value.split("\n")[0]!.trim()
	return line.length > ARG_MAX ? `${line.slice(0, ARG_MAX - 1).trimEnd()}…` : line
}

/**
 * The one argument worth showing, or nothing.
 *
 * Nothing is a perfectly good answer. A label that pads itself with whichever
 * key happened to be first reads as detail while carrying none, and the tools
 * whose arguments are all time bounds are exactly the ones where that happens.
 */
const salientArg = (input: ToolCallInput): string | null => {
	for (const key of SALIENT_KEYS) {
		const text = asText(input[key])
		if (text !== null) return clamp(text)
	}
	return null
}

/**
 * A tool call as a line of English.
 *
 * Derived from the tool name rather than mapped from it. A map over ~47 tools is
 * a map that goes stale the first time one is added and nobody notices, because
 * a missing entry degrades to something plausible. Maple's tool names are
 * already verb-first snake case, so the derivation is the map.
 */
export const stepLabel = (tool: string, input: ToolCallInput): string => {
	const words = tool.split("_").filter((word) => word.length > 0)
	const phrase =
		words.length === 0
			? tool
			: `${words[0]!.charAt(0).toUpperCase()}${words[0]!.slice(1)} ${words.slice(1).join(" ")}`.trim()
	const arg = salientArg(input)
	return arg === null ? phrase : `${phrase} · ${arg}`
}

export interface ProgressRecorder {
	/**
	 * Note a tool call. Returns the record to write, or `undefined` while the
	 * heartbeat has not elapsed.
	 */
	readonly step: (tool: string, input: ToolCallInput, nowMs: number) => InvestigationProgress | undefined
	/** The record as it stands, for the flush a run's end owes its last steps. */
	readonly pending: () => InvestigationProgress | undefined
}

export const makeProgressRecorder = (): ProgressRecorder => {
	let steps: Array<InvestigationStep> = []
	let stepCount = 0
	let lastWriteMs: number | undefined
	let dirty = false

	const snapshot = (): InvestigationProgress => ({
		stepCount,
		steps: [...steps],
		updatedAt: steps.at(-1)?.at ?? 0,
	})

	return {
		step: (tool, input, nowMs) => {
			stepCount += 1
			steps = [...steps, { tool, label: stepLabel(tool, input), at: nowMs }].slice(
				-INVESTIGATION_PROGRESS_STEPS,
			)
			dirty = true
			// The first step always writes. It is the one that turns a page saying
			// "gathering evidence" into a page saying what is being gathered, and
			// making a reader wait a heartbeat for it is the whole complaint.
			if (lastWriteMs !== undefined && nowMs - lastWriteMs < PROGRESS_HEARTBEAT_MS) return undefined
			lastWriteMs = nowMs
			dirty = false
			return snapshot()
		},
		pending: () => {
			if (!dirty) return undefined
			dirty = false
			return snapshot()
		},
	}
}
