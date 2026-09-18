/**
 * What a running investigation is doing, accumulated from its tool-call events and handed to
 * `InvestigationService` as a whole record on a heartbeat. The table replicates with REPLICA
 * IDENTITY FULL, so a write per tool call would ship the entire row up to a hundred times a run.
 */
import { Option, Schema } from "effect"
import {
	INVESTIGATION_PROGRESS_STEPS,
	type InvestigationProgress,
	type InvestigationStep,
} from "@maple/domain/http"

/** `ChatToolCallEvent.input` is `Schema.Unknown` on the wire; this is the one parse into a record. */
export const ToolCallInput = Schema.Record(Schema.String, Schema.Unknown)
export type ToolCallInput = Schema.Schema.Type<typeof ToolCallInput>

const decode = Schema.decodeUnknownOption(ToolCallInput)

/** A tool call's arguments, or an empty record when they are not one. */
export const parseToolInput = (input: unknown): ToolCallInput => Option.getOrElse(decode(input), () => ({}))

/** How long a step may sit in memory before it is worth a write. */
export const PROGRESS_HEARTBEAT_MS = 8_000

/** Longest argument fragment a label will carry. */
const ARG_MAX = 32

/** Input keys worth naming in a label, most specific first. */
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

/** The one argument worth showing, or nothing: a label padded with a time bound reads as detail while carrying none. */
const salientArg = (input: ToolCallInput): string | null => {
	for (const key of SALIENT_KEYS) {
		const text = asText(input[key])
		if (text !== null) return clamp(text)
	}
	return null
}

/** Words that stay upper case when a tool name is read as a phrase. */
const ACRONYMS = new Set(["sql", "id", "api", "mcp"])

const word = (raw: string, first: boolean): string =>
	ACRONYMS.has(raw) ? raw.toUpperCase() : first ? `${raw.charAt(0).toUpperCase()}${raw.slice(1)}` : raw

/**
 * A tool call as a line of English, derived from the verb-first snake-case tool name rather than
 * mapped from it: a map over ~47 tools goes stale the first time one is added and nobody notices.
 */
export const stepLabel = (tool: string, input: ToolCallInput): string => {
	const words = tool.split("_").filter((part) => part.length > 0)
	const phrase = words.length === 0 ? tool : words.map((part, index) => word(part, index === 0)).join(" ")
	const arg = salientArg(input)
	return arg === null ? phrase : `${phrase} · ${arg}`
}

export interface ProgressRecorder {
	/** Note a tool call. Returns the record to write, or `undefined` while the heartbeat has not elapsed. */
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
			// The first step always writes; making a reader wait a heartbeat for it is the whole complaint.
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
