import { Effect, Schema } from "effect"
import { Mount } from "foldkit"
import { defineMessageUnion } from "foldkit/message"

// `@streamdown/math` (remark-math with `singleDollarTextMath: false`, rehype-katex). `@foldkit/markdown`
// has no math syntax, so math is rewritten before the parse: flow math (`$$` fences) becomes a
// ```math fence (rehype-katex renders those as display math too) and text math (`$$…$$`) an inline
// code span marked with `MATH_MARK`. KaTeX loads with the first formula and draws it in a Mount.

/** First character of an inline code span that is really text math. */
export const MATH_MARK = ""

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const MATH_OPEN = /^( {0,3})(\${2,})([^$]*)$/
const MATH_CLOSE = /^ {0,3}(\${2,})[ \t]*$/

const runAt = (text: string, index: number, char: string): number => {
	const match = text.slice(index).match(char === "`" ? /^`+/ : /^\$+/)
	return match === null ? 0 : match[0].length
}

/** The index of the next run of exactly `length` `char`s from `from`, or -1. */
const closingRun = (text: string, from: number, char: string, length: number): number => {
	const next = text.indexOf(char, from)
	if (next === -1) return -1
	const run = runAt(text, next, char)
	return run === length ? next : closingRun(text, next + run, char, length)
}

/** A code span holding `content` verbatim (a fence longer than any backtick run inside). */
const codeSpan = (content: string): string => {
	const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
	const fence = "`".repeat(longest + 1)
	const padded = content.endsWith("`") ? ` ${content} ` : content
	return `${fence}${padded}${fence}`
}

/** micromark's text math padding: one space or line ending off each side, unless it is all spaces. */
const unpad = (tex: string): string =>
	/^[ \n]/.test(tex) && /[ \n]$/.test(tex) && tex.trim() !== "" ? tex.slice(1, -1) : tex

/** An escaped punctuation character, a backtick or dollar run, or a stretch of anything else. */
const TOKEN = /^(?:\\[!-/:-@[-`{-~]|`+|\$+|[^\\`$]+|\\)/

/** One paragraph, token by token: escapes and code spans pass through, `$$…$$` becomes a marked span. */
const rewriteText = (text: string, index = 0, out = ""): string => {
	if (index >= text.length) return out
	const token = text.slice(index).match(TOKEN)?.[0] ?? text.slice(index)
	const char = token.charAt(0)
	if (char !== "`" && char !== "$") return rewriteText(text, index + token.length, out + token)
	const run = token.length
	const close = char === "$" && run < 2 ? -1 : closingRun(text, index + run, char, run)
	if (close === -1) return rewriteText(text, index + run, out + text.slice(index, index + run))
	const piece =
		char === "`" ? text.slice(index, close + run) : codeSpan(MATH_MARK + unpad(text.slice(index + run, close)))
	return rewriteText(text, close + run, out + piece)
}

type OpenMath = Readonly<{ run: number; indent: number; lines: ReadonlyArray<string> }>
type Scan = Readonly<{
	done: ReadonlyArray<string>
	prose: ReadonlyArray<string>
	fence: string | null
	math: OpenMath | null
}>

const mathFence = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
	const longest = Math.max(2, ...lines.flatMap((line) => line.match(/`+/g) ?? []).map((run) => run.length))
	const fence = "`".repeat(longest + 1)
	return [`${fence}math`, ...lines, fence]
}

const flush = (scan: Scan): Scan =>
	scan.prose.length === 0 ? scan : { ...scan, done: [...scan.done, ...rewriteText(scan.prose.join("\n")).split("\n")], prose: [] }

const step = (scan: Scan, line: string): Scan => {
	const { math, fence } = scan
	if (math !== null) {
		const close = MATH_CLOSE.exec(line)
		if (close !== null && (close[1]?.length ?? 0) >= math.run) return { ...scan, done: [...scan.done, ...mathFence(math.lines)], math: null }
		const dedented = line.replace(new RegExp(`^ {0,${math.indent}}`), "")
		return { ...scan, math: { ...math, lines: [...math.lines, dedented] } }
	}
	const marker = FENCE.exec(line)?.[1]
	if (fence !== null) {
		const closes = marker !== undefined && marker.charAt(0) === fence.charAt(0) && marker.length >= fence.length
		return { ...scan, done: [...scan.done, line], fence: closes ? null : fence }
	}
	if (marker !== undefined) return { ...flush(scan), done: [...flush(scan).done, line], fence: marker }
	const open = MATH_OPEN.exec(line)
	if (open !== null) return { ...flush(scan), math: { run: open[2]?.length ?? 2, indent: open[1]?.length ?? 0, lines: [] } }
	if (line.trim() === "") return { ...flush(scan), done: [...flush(scan).done, line] }
	return { ...scan, prose: [...scan.prose, line] }
}

export const MathMessage = defineMessageUnion({ CompletedMountMath: {} })

/** `createMathPlugin`'s `errorColor`. */
const ERROR_COLOR = "var(--color-muted-foreground)"

const escapeHtml = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/**
 * rehype-katex on one formula: strict first, then KaTeX's own error rendering, then the
 * `katex-error` span. The element is an unstyled span the formula's markup is drawn into.
 */
export const MountMath = Mount.define("MountChatMath", {
	args: { tex: Schema.String, isDisplay: Schema.Boolean },
	messages: [MathMessage.CompletedMountMath],
	execute: ({ element, tex, isDisplay }) =>
		Effect.gen(function* () {
			const { default: katex } = yield* Effect.promise(() => import("katex"))
			const settings = { errorColor: ERROR_COLOR, displayMode: isDisplay }
			const html = yield* Effect.try({ try: () => katex.renderToString(tex, { ...settings, throwOnError: true }), catch: (cause) => cause }).pipe(
				Effect.catch((error) =>
					Effect.try(() => katex.renderToString(tex, { ...settings, strict: "ignore", throwOnError: false })).pipe(
						Effect.orElseSucceed(
							() =>
								`<span class="katex-error" style="color:${ERROR_COLOR}" title="${escapeHtml(String(error))}">${escapeHtml(tex)}</span>`,
						),
					),
				),
			)
			yield* Effect.sync(() => {
				element.innerHTML = html
			})
			return MathMessage.CompletedMountMath()
		}),
})

/** The text with its math rewritten for `@foldkit/markdown` (see the top of this file). */
export const prepareMath = (text: string): string => {
	if (!text.includes("$$")) return text
	const scan = flush(text.split("\n").reduce(step, { done: [], prose: [], fence: null, math: null }))
	return (scan.math === null ? scan.done : [...scan.done, ...mathFence(scan.math.lines)]).join("\n")
}
