/**
 * The parts of a unified diff the telemetry analysis reads: each line, which side it is on, and
 * the new-side line a finding about it can anchor to.
 */

export interface DiffLine {
	readonly kind: "add" | "del" | "ctx"
	readonly text: string
	/**
	 * On the new side for an added or context line. For a removed line, the new-side line the
	 * removal sits at, since GitHub anchors comments only on the new side.
	 */
	readonly newLine: number
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export const parsePatch = (patch: string | null): ReadonlyArray<DiffLine> => {
	if (patch === null) return []
	const lines: Array<DiffLine> = []
	let newLine = 0
	for (const raw of patch.split("\n")) {
		const hunk = HUNK.exec(raw)
		if (hunk !== null) {
			newLine = Number(hunk[1])
			continue
		}
		if (newLine === 0 || raw.startsWith("\\")) continue
		if (raw.startsWith("+")) {
			lines.push({ kind: "add", text: raw.slice(1), newLine })
			newLine += 1
		} else if (raw.startsWith("-")) {
			lines.push({ kind: "del", text: raw.slice(1), newLine: Math.max(1, newLine) })
		} else {
			lines.push({ kind: "ctx", text: raw.slice(1), newLine })
			newLine += 1
		}
	}
	return lines
}

/** Files whose strings say nothing about what production emits. */
const NOT_RUNTIME =
	/(^|\/)(__tests__|__mocks__|test|tests|fixtures|e2e|docs?|examples?)\/|\.(test|spec|stories|e2e)\.[a-z]+$|\.(md|mdx|txt|snap|lock|json|ya?ml)$/i

export const isRuntimeSource = (path: string): boolean => !NOT_RUNTIME.test(path)

/** A string literal in a line of code, and where it starts. */
export interface Literal {
	readonly value: string
	readonly index: number
	/** A template literal with an interpolation: its text is not a stable name. */
	readonly templated: boolean
}

const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g

export const literalsOf = (text: string): ReadonlyArray<Literal> => {
	const out: Array<Literal> = []
	for (const match of text.matchAll(STRING_LITERAL)) {
		const value = match[2] ?? ""
		if (value.length < 3 || value.length > 160) continue
		out.push({ value, index: match.index ?? 0, templated: match[1] === "`" && value.includes("${") })
	}
	return out
}

/** Calls whose first argument names a span. */
const SPAN_CALL =
	/(?:withSpan|startSpan|startActiveSpan|Effect\.fn|useSpan|makeSpan|tracer\.span|trace\.span|instrument|start_as_current_span|start_span)\s*\(\s*$/
/** Calls whose first argument names a metric instrument. */
const METRIC_CALL =
	/(?:Metric\.(?:counter|gauge|histogram|frequency|summary|timer)|create(?:Counter|Histogram|UpDownCounter|Gauge|ObservableGauge|ObservableCounter)|create_(?:counter|histogram|up_down_counter|gauge))\s*\(\s*$/
/** Calls that put attributes on a span, by name or as an object. */
const ATTRIBUTE_CALL =
	/(?:setAttributes?|annotateCurrentSpan|annotateSpans|addEvent|set_attributes?|SpanAttributes|attributes\s*:)/
const LOG_CALL =
	/\b(?:console\.(?:log|info|warn|error|debug)|logger\.(?:info|warn|warning|error|debug|trace)|log\.(?:info|warn|error|debug)|Effect\.log(?:Info|Warning|Error|Debug)?|logging\.(?:info|warning|error|debug)|slog\.(?:Info|Warn|Error|Debug))\s*\(/

/** A name the code passes to the telemetry API, classified by the call it is in. */
export interface EmittedName {
	readonly kind: "span" | "attribute" | "metric"
	readonly value: string
	readonly templated: boolean
}

const ATTRIBUTE_KEY = /^[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)+$/i

/**
 * Names a line hands to the telemetry API. `nearby` is the few lines above it, so an attribute
 * object spread over several lines is still recognized.
 */
export const emittedNames = (text: string, nearby: string): ReadonlyArray<EmittedName> => {
	const out: Array<EmittedName> = []
	for (const literal of literalsOf(text)) {
		const before = text.slice(0, literal.index)
		const after = text.slice(literal.index + literal.value.length + 2)
		if (SPAN_CALL.test(before)) {
			out.push({ kind: "span", value: literal.value, templated: literal.templated })
		} else if (METRIC_CALL.test(before)) {
			out.push({ kind: "metric", value: literal.value, templated: literal.templated })
		} else if (
			!literal.templated &&
			ATTRIBUTE_KEY.test(literal.value) &&
			(ATTRIBUTE_CALL.test(before) || (/^\s*[:,]/.test(after) && ATTRIBUTE_CALL.test(nearby)))
		) {
			out.push({ kind: "attribute", value: literal.value, templated: false })
		}
	}
	return out
}

export const isLogCall = (text: string): boolean => LOG_CALL.test(text)

/** A line that is only a comment, in the comment syntaxes runtime sources use. */
export const isCommentLine = (text: string): boolean => /^\s*(\/\/|#|\*|\/\*|--)/.test(text)

/**
 * The first line of a file that still emits a name: code, not a comment or a log message, holding
 * the name as a quoted string. 1-based; undefined when no line does.
 */
export const lineEmitting = (content: string, name: string): number | undefined => {
	const quoted = [`"${name}"`, `'${name}'`, `\`${name}\``]
	const index = content
		.split("\n")
		.findIndex(
			(text) =>
				!isCommentLine(text) && !isLogCall(text) && quoted.some((value) => text.includes(value)),
		)
	return index === -1 ? undefined : index + 1
}
