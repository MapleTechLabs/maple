// BOUNDARY: This module reads model-authored table text and narrows it before it
// becomes a link or a color.
import type { LatencyScale } from "@maple/ui/lib/latency-tone"

/**
 * What a column is about, read off its header. Shape alone settles some cells —
 * a 32-character hex string is a trace id wherever it appears — but not all of
 * them: `no` is only reassuring under an "Error" header, and under "Sampled" it
 * means nothing at all. Where the meaning depends on the column, an unrecognized
 * header is a reason to leave the cell alone rather than to guess.
 */
export type ColumnRole = "trace" | "service" | "duration" | "error" | "status" | "severity"

export type CellValue =
	| { readonly kind: "plain" }
	| { readonly kind: "trace"; readonly traceId: string }
	| { readonly kind: "service"; readonly name: string }
	| {
			readonly kind: "duration"
			readonly ms: number
			readonly scale: LatencyScale
			readonly value: string
			/** A trailing gloss the model wrote, e.g. the `(~78 min)` after `4672.46s`. */
			readonly note: string | null
	  }
	| { readonly kind: "severity"; readonly label: string }
	| { readonly kind: "flag"; readonly severe: boolean; readonly text: string }
	| { readonly kind: "status"; readonly code: number; readonly text: string }

const PLAIN: CellValue = { kind: "plain" }

const TRACE_ID_RE = /^[0-9a-f]{32}$/i
const STATUS_RE = /^[1-5]\d{2}$/
const COUNT_RE = /^\d[\d,]*$/
const SEVERITY_LABELS = new Set(["TRACE", "DEBUG", "INFO", "WARN", "WARNING", "ERROR", "FATAL"])

/**
 * `4672.46s (~78 min)` — a number, a unit, and an optional parenthetical. Units
 * are a closed set so a bare count like `5` or a version like `1.2` never reads
 * as a duration.
 */
const DURATION_RE =
	/^~?\s*(\d[\d,]*(?:\.\d+)?)\s*(ms|msec|msecs|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\s*(\([^)]*\))?$/i

const UNIT_MS = new Map<string, number>([
	["h", 3_600_000],
	["hour", 3_600_000],
	["hours", 3_600_000],
	["hr", 3_600_000],
	["hrs", 3_600_000],
	["m", 60_000],
	["min", 60_000],
	["mins", 60_000],
	["minute", 60_000],
	["minutes", 60_000],
	["ms", 1],
	["msec", 1],
	["msecs", 1],
	["millisecond", 1],
	["milliseconds", 1],
	["s", 1000],
	["sec", 1000],
	["secs", 1000],
	["second", 1000],
	["seconds", 1000],
])

/** Header phrasings, loosest first — the model writes "Duration", "p99 latency", "Avg". */
export function columnRole(header: string): ColumnRole | null {
	const text = header.toLowerCase()
	if (/trace\s*id|^trace$/.test(text)) return "trace"
	if (/service|operation owner/.test(text)) return "service"
	if (/duration|latency|elapsed|\bp5\d\b|\bp9\d\b|response time/.test(text)) return "duration"
	if (/error|fail|crash|exception/.test(text)) return "error"
	if (/status|http code|\bcode\b/.test(text)) return "status"
	if (/severity|level/.test(text)) return "severity"
	return null
}

/**
 * Which latency budget the column is measured against. A p99 column is expected
 * to be slower than a p50 one, so reading the percentile out of the header is
 * what keeps a healthy p99 from rendering as an incident. Unlabeled columns take
 * the p99 budget, the most forgiving of the four.
 */
export function durationScale(header: string): LatencyScale {
	const text = header.toLowerCase()
	if (/\bp5\d\b|median/.test(text)) return "p50"
	if (/\bavg\b|average|\bmean\b/.test(text)) return "avg"
	if (/\bp9[0-8]\b/.test(text)) return "p95"
	return "p99"
}

function parseDuration(text: string, scale: LatencyScale): CellValue | null {
	const match = DURATION_RE.exec(text)
	if (!match) return null
	const amount = Number(match[1]!.replaceAll(",", ""))
	const unit = UNIT_MS.get(match[2]!.toLowerCase())
	if (!Number.isFinite(amount) || unit === undefined) return null
	const note = match[3] ?? null
	const value = note ? text.slice(0, text.length - note.length).trimEnd() : text
	return { kind: "duration", ms: amount * unit, scale, value, note }
}

export interface ClassifyOptions {
	/** The role of the column this cell sits in, or null when the header said nothing. */
	readonly role: ColumnRole | null
	/** The header text itself, for the latency budget. */
	readonly header: string
	/**
	 * Services the org actually reports. A service only becomes a link when it is
	 * in here: a link to a service page that does not exist is worse than text.
	 */
	readonly knownServices: ReadonlySet<string>
}

/**
 * Read one table cell. Anything not recognized with certainty comes back as
 * `plain` and renders as the model wrote it — a color is a claim about the data,
 * and a wrong claim in a reply about production costs more than a missing one.
 */
export function classifyCell(raw: string, options: ClassifyOptions): CellValue {
	const text = raw.trim()
	if (text.length === 0) return PLAIN

	if (TRACE_ID_RE.test(text)) return { kind: "trace", traceId: text.toLowerCase() }

	if (SEVERITY_LABELS.has(text.toUpperCase())) return { kind: "severity", label: text.toUpperCase() }

	const duration = parseDuration(text, durationScale(options.header))
	if (duration) return duration

	switch (options.role) {
		case "service": {
			return options.knownServices.has(text) ? { kind: "service", name: text } : PLAIN
		}
		case "error": {
			const lower = text.toLowerCase()
			if (lower === "yes" || lower === "true") return { kind: "flag", severe: true, text }
			if (lower === "no" || lower === "false" || lower === "none") {
				return { kind: "flag", severe: false, text }
			}
			if (COUNT_RE.test(text)) {
				return { kind: "flag", severe: Number(text.replaceAll(",", "")) > 0, text }
			}
			return PLAIN
		}
		case "status": {
			return STATUS_RE.test(text) ? { kind: "status", code: Number(text), text } : PLAIN
		}
		default:
			return PLAIN
	}
}
