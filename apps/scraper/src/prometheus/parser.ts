/**
 * Parser for the Prometheus text exposition format (text/plain; version=0.0.4)
 * with tolerance for OpenMetrics output (`# EOF`, `# UNIT`, exemplar suffixes,
 * `unknown` type, `_total`-suffixed counter samples).
 *
 * Pure and total: malformed lines are skipped (counted in
 * `skippedLineCount`), never thrown.
 */

export type PromMetricType = "counter" | "gauge" | "histogram" | "summary" | "untyped"

export interface PromSample {
	readonly name: string
	readonly labels: Readonly<Record<string, string>>
	/** May be NaN / +-Infinity — Prometheus emits `NaN`, `+Inf`, `-Inf`. */
	readonly value: number
	/** Exposition timestamp in epoch ms, or null when the line has none. */
	readonly timestampMs: number | null
}

export interface PromMetricFamily {
	readonly name: string
	readonly type: PromMetricType
	readonly help: string | null
	readonly unit: string | null
	readonly samples: ReadonlyArray<PromSample>
}

export interface PromParseResult {
	readonly families: ReadonlyArray<PromMetricFamily>
	readonly skippedLineCount: number
}

interface MutableFamily {
	name: string
	type: PromMetricType
	help: string | null
	unit: string | null
	samples: Array<PromSample>
}

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*/
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/

/** Unescape a HELP text or label value: `\\` -> `\`, `\"` -> `"`, `\n` -> newline. */
const unescapeValue = (raw: string): string => {
	if (!raw.includes("\\")) return raw
	let out = ""
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]
		if (ch === "\\" && i + 1 < raw.length) {
			const next = raw[i + 1]
			if (next === "\\") {
				out += "\\"
				i++
				continue
			}
			if (next === "n") {
				out += "\n"
				i++
				continue
			}
			if (next === '"') {
				out += '"'
				i++
				continue
			}
		}
		out += ch
	}
	return out
}

const parseSampleValue = (token: string): number | null => {
	switch (token) {
		case "+Inf":
		case "Inf":
			return Number.POSITIVE_INFINITY
		case "-Inf":
			return Number.NEGATIVE_INFINITY
		case "NaN":
		case "Nan":
		case "nan":
			return Number.NaN
		default: {
			if (token.length === 0) return null
			const value = Number(token)
			return Number.isNaN(value) ? null : value
		}
	}
}

/**
 * Exposition timestamps are epoch *milliseconds* (Prometheus text format) but
 * epoch *seconds* (possibly fractional) in OpenMetrics. Disambiguate by
 * magnitude: anything below 1e11 (~5138-11-16 in ms) is treated as seconds.
 */
const normalizeTimestamp = (raw: number): number => (Math.abs(raw) < 1e11 ? Math.round(raw * 1000) : Math.round(raw))

interface ParsedLabels {
	readonly labels: Record<string, string>
	/** Index just past the closing `}`. */
	readonly end: number
}

/** Scan a `{name="value",...}` block starting at `pos` (which must point at `{`). */
const parseLabels = (line: string, pos: number): ParsedLabels | null => {
	const labels: Record<string, string> = {}
	let i = pos + 1
	for (;;) {
		while (line[i] === " " || line[i] === "\t" || line[i] === ",") i++
		if (i >= line.length) return null
		if (line[i] === "}") return { labels, end: i + 1 }

		const nameMatch = LABEL_NAME_RE.exec(line.slice(i))
		if (!nameMatch) return null
		const name = nameMatch[0]
		i += name.length
		while (line[i] === " " || line[i] === "\t") i++
		if (line[i] !== "=") return null
		i++
		while (line[i] === " " || line[i] === "\t") i++
		if (line[i] !== '"') return null
		i++
		let raw = ""
		for (;;) {
			if (i >= line.length) return null
			const ch = line[i]
			if (ch === "\\") {
				if (i + 1 >= line.length) return null
				raw += ch + line[i + 1]
				i += 2
				continue
			}
			if (ch === '"') {
				i++
				break
			}
			raw += ch
			i++
		}
		labels[name] = unescapeValue(raw)
	}
}

interface ParsedSample {
	readonly name: string
	readonly labels: Record<string, string>
	readonly value: number
	readonly timestampMs: number | null
}

const parseSampleLine = (line: string): ParsedSample | null => {
	const nameMatch = METRIC_NAME_RE.exec(line)
	if (!nameMatch) return null
	const name = nameMatch[0]
	let i = name.length

	let labels: Record<string, string> = {}
	if (line[i] === "{") {
		const parsed = parseLabels(line, i)
		if (parsed === null) return null
		labels = parsed.labels
		i = parsed.end
	}

	let rest = line.slice(i).trim()
	if (rest.length === 0) return null

	// OpenMetrics exemplars trail the value/timestamp after a `#`:
	//   foo_bucket{le="0.1"} 8 # {trace_id="…"} 0.054
	// The `#` cannot appear inside the value/timestamp tokens, so a plain
	// index lookup is safe here (label values were already consumed above).
	const exemplarStart = rest.indexOf("#")
	if (exemplarStart >= 0) rest = rest.slice(0, exemplarStart).trim()

	const tokens = rest.split(/[ \t]+/)
	if (tokens.length === 0 || tokens.length > 2) return null

	const value = parseSampleValue(tokens[0]!)
	if (value === null) return null

	let timestampMs: number | null = null
	if (tokens.length === 2) {
		const rawTs = Number(tokens[1])
		if (Number.isNaN(rawTs)) return null
		timestampMs = normalizeTimestamp(rawTs)
	}

	return { name, labels, value, timestampMs }
}

const COMPONENT_SUFFIXES = ["_bucket", "_count", "_sum", "_total"] as const

/**
 * Find the family a sample belongs to: exact name first, then the base name
 * with a known component suffix stripped (histogram `_bucket`/`_sum`/`_count`,
 * summary `_sum`/`_count`, OpenMetrics counter `_total`).
 */
const familyForSample = (families: Map<string, MutableFamily>, sampleName: string): MutableFamily | undefined => {
	const exact = families.get(sampleName)
	if (exact) return exact
	for (const suffix of COMPONENT_SUFFIXES) {
		if (sampleName.endsWith(suffix)) {
			const family = families.get(sampleName.slice(0, -suffix.length))
			if (family) return family
		}
	}
	return undefined
}

const parseType = (raw: string): PromMetricType => {
	switch (raw) {
		case "counter":
		case "gauge":
		case "histogram":
		case "summary":
			return raw
		default:
			// OpenMetrics `unknown`, exotic types (`gaugehistogram`, `info`,
			// `stateset`) and anything unrecognized degrade to untyped.
			return "untyped"
	}
}

export const parsePrometheusText = (body: string): PromParseResult => {
	const families = new Map<string, MutableFamily>()
	let skippedLineCount = 0

	const ensureFamily = (name: string): MutableFamily => {
		let family = families.get(name)
		if (!family) {
			family = { name, type: "untyped", help: null, unit: null, samples: [] }
			families.set(name, family)
		}
		return family
	}

	for (const rawLine of body.split("\n")) {
		const line = (rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine).trim()
		if (line.length === 0) continue

		if (line.startsWith("#")) {
			const comment = line.slice(1).trim()
			if (comment.startsWith("TYPE ")) {
				const rest = comment.slice(5).trim()
				const nameMatch = METRIC_NAME_RE.exec(rest)
				if (!nameMatch) {
					skippedLineCount++
					continue
				}
				const family = ensureFamily(nameMatch[0])
				family.type = parseType(rest.slice(nameMatch[0].length).trim().toLowerCase())
			} else if (comment.startsWith("HELP ")) {
				const rest = comment.slice(5)
				const nameMatch = METRIC_NAME_RE.exec(rest.trimStart())
				if (!nameMatch) {
					skippedLineCount++
					continue
				}
				const family = ensureFamily(nameMatch[0])
				family.help = unescapeValue(rest.trimStart().slice(nameMatch[0].length).trimStart())
			} else if (comment.startsWith("UNIT ")) {
				const rest = comment.slice(5).trim()
				const nameMatch = METRIC_NAME_RE.exec(rest)
				if (nameMatch) {
					ensureFamily(nameMatch[0]).unit = rest.slice(nameMatch[0].length).trim() || null
				}
			}
			// `# EOF` and free-form comments are ignored.
			continue
		}

		const sample = parseSampleLine(line)
		if (sample === null) {
			skippedLineCount++
			continue
		}

		// OpenMetrics `_created` series carry start timestamps for counters /
		// histograms / summaries — metadata we do not store; drop silently.
		if (sample.name.endsWith("_created") && familyForSample(families, sample.name.slice(0, -8)) !== undefined) {
			continue
		}

		const family = familyForSample(families, sample.name) ?? ensureFamily(sample.name)
		family.samples.push(sample)
	}

	return {
		families: [...families.values()].filter((family) => family.samples.length > 0),
		skippedLineCount,
	}
}
