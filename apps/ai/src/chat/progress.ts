/**
 * What a running investigation is doing, accumulated from its tool-call events and handed to
 * `InvestigationService` as a whole record on a heartbeat. The table replicates with REPLICA
 * IDENTITY FULL, so a write per tool call would ship the entire row up to a hundred times a run.
 */
import { Option, Schema, SchemaGetter } from "effect"
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
	"paths",
	"title",
	"command",
	"sql",
] as const

const Scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
const scalarText = (value: typeof Scalar.Type): string => String(value).trim()

/** An argument as one line: a scalar as itself, a list by its first item and a count (`a.ts +2`). */
const ArgText = Schema.Union([Scalar, Schema.NonEmptyArray(Scalar)]).pipe(
	Schema.decodeTo(Schema.NonEmptyString, {
		decode: SchemaGetter.transform((value) => {
			if (typeof value !== "object") return scalarText(value)
			const first = scalarText(value[0])
			return first === "" || value.length === 1 ? first : `${first} +${value.length - 1}`
		}),
		encode: SchemaGetter.forbidden(() => "a step label is never encoded back into arguments"),
	}),
)
const decodeArg = Schema.decodeUnknownOption(ArgText)

const clamp = (value: string): string => {
	const line = value.split("\n")[0]!.trim()
	return line.length > ARG_MAX ? `${line.slice(0, ARG_MAX - 1).trimEnd()}…` : line
}

/** The one argument worth showing, or nothing: a label padded with a time bound reads as detail while carrying none. */
const salientArg = (input: ToolCallInput): string | null =>
	Option.match(Option.firstSomeOf(SALIENT_KEYS.map((key) => decodeArg(input[key]))), {
		onNone: () => null,
		onSome: clamp,
	})

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
	/** The record as it stands, written or not, for a write the run forces at a phase change. */
	readonly current: () => InvestigationProgress
}

/** A review edits a GitHub comment per write, so it beats slower than an investigation's row. */
export const REVIEW_PROGRESS_HEARTBEAT_MS = 30_000

export const makeProgressRecorder = (heartbeatMs = PROGRESS_HEARTBEAT_MS): ProgressRecorder => {
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
			if (lastWriteMs !== undefined && nowMs - lastWriteMs < heartbeatMs) return undefined
			lastWriteMs = nowMs
			dirty = false
			return snapshot()
		},
		pending: () => {
			if (!dirty) return undefined
			dirty = false
			return snapshot()
		},
		current: () => {
			dirty = false
			return snapshot()
		},
	}
}
