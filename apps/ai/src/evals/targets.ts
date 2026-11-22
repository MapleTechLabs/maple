/**
 * What a trial has to achieve, and the deterministic grader that checks it.
 *
 * A task states acceptable outcomes, never one exact spelling. Every call is read through the
 * registry first (`readToolCall`), so a retired parameter name or a lowercase enum means what the
 * dispatcher would make of it. Expectations list every acceptable answer (BFCL's per-argument
 * value lists), and a call anywhere in the trajectory can satisfy them, not only the first.
 */
import { Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { stringifyJson } from "../mcp/lib/json"
import { readToolCall } from "../mcp/tools/registry"

const encodeJson = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))
/** `JSON.stringify` for a message: a value with no JSON form reads as `String(value)`. */
const showJson = (value: unknown): string => Option.getOrElse(encodeJson(value), () => String(value))

export type Scalar = string | number | boolean

/** One argument's acceptable values. A bare scalar means "equal to this". */
export type ArgExpectation =
	| Scalar
	| { readonly oneOf: ReadonlyArray<Scalar> }
	/** Equal to this, or omitted because this is the tool's default. */
	| { readonly orDefault: Scalar }
	/** Case-insensitive substring of free text, or of a structured argument as JSON. */
	| { readonly includes: string }
	| { readonly absent: true }
	| { readonly present: true }

/** One acceptable call: this tool, with at least these arguments meaning these values. */
export interface CallExpectation {
	readonly tool: string
	readonly args?: Readonly<Record<string, ArgExpectation>>
}

/** A trial passes when every check does. */
export type Check =
	/** Some call in the trajectory matches one of these alternatives. */
	| { readonly kind: "calls"; readonly anyOf: ReadonlyArray<CallExpectation> }
	/** None of these tools was called at all. */
	| { readonly kind: "never"; readonly tools: ReadonlyArray<string> }
	/** No tool was called: the right answer needed none. */
	| { readonly kind: "no-tools" }
	/** The final answer names at least one of these (case-insensitive). */
	| { readonly kind: "answer-mentions"; readonly anyOf: ReadonlyArray<string> }
	/**
	 * The final answer states this number, in any digit grouping. With `percent`, `value` is a 0-1
	 * share and the answer has to give it as a percentage (rounded to a whole percent is fine).
	 */
	| {
			readonly kind: "answer-number"
			readonly label: string
			readonly value: number
			readonly percent?: boolean
	  }
	/** The final answer states a duration within `tolerance` (a 0-1 share) of this many milliseconds. */
	| {
			readonly kind: "answer-duration"
			readonly label: string
			readonly ms: number
			readonly tolerance: number
	  }

export const call = (tool: string, args?: CallExpectation["args"]): CallExpectation =>
	args === undefined ? { tool } : { tool, args }

export const calls = (...anyOf: ReadonlyArray<CallExpectation>): Check => ({ kind: "calls", anyOf })
export const never = (...tools: ReadonlyArray<string>): Check => ({ kind: "never", tools })
export const noTools: Check = { kind: "no-tools" }
export const answerMentions = (...anyOf: ReadonlyArray<string>): Check => ({ kind: "answer-mentions", anyOf })
export const answerNumber = (label: string, value: number): Check => ({ kind: "answer-number", label, value })
export const answerPercent = (label: string, share: number): Check => ({
	kind: "answer-number",
	label,
	value: share,
	percent: true,
})
export const answerDuration = (label: string, ms: number, tolerance = 0.05): Check => ({
	kind: "answer-duration",
	label,
	ms,
	tolerance,
})

// Dates and clock times are full of digits that are not quantities.
const DATE_OR_TIME =
	/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?|\b\d{1,2}:\d{2}(?::\d{2})?\b/g
// Not inside a word or an identifier: `u_017`, `d12` and `v2` name things.
const NUMBER = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s*%)?/g

/** The quantities a text states: plain numbers, and percentages as written (37.5 for `37.5%`). */
export const numbersIn = (
	text: string,
): { readonly plain: ReadonlyArray<number>; readonly percents: ReadonlyArray<number> } => {
	const matches = Arr.fromIterable(Str.matchAll(NUMBER)(Str.replace(DATE_OR_TIME, " ")(text)))
	const read = (match: RegExpMatchArray): number =>
		Number(`${Str.replaceAll(",", "")(match[1] ?? "")}${match[2] ?? ""}`)
	return {
		plain: Arr.map(
			Arr.filter(matches, (match) => match[3] === undefined),
			read,
		),
		percents: Arr.map(
			Arr.filter(matches, (match) => match[3] !== undefined),
			read,
		),
	}
}

const UNIT_MS: ReadonlyArray<readonly [RegExp, number]> = [
	[/^(?:d|days?)$/, 86_400_000],
	[/^(?:h|hrs?|hours?)$/, 3_600_000],
	[/^(?:m|mins?|minutes?)$/, 60_000],
	[/^(?:s|secs?|seconds?)$/, 1_000],
	[/^ms$/, 1],
]
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|ms|d|h|m|s)\b/gi
/** What may sit between two parts of one duration: `1h 5m`, `1 hour, 5 minutes`, `1 hour and 5 minutes`. */
const JOINER = /^[\s,]*(?:and)?[\s,]*$/i

/** The durations a text states, in milliseconds: `1h 5m` is one duration, not two. */
export const durationsIn = (text: string): ReadonlyArray<number> => {
	const parts = Arr.map(Arr.fromIterable(Str.matchAll(DURATION_PART)(text)), (match) => {
		const unit = Str.toLowerCase(match[2] ?? "")
		const size = Arr.findFirst(UNIT_MS, ([pattern]) => pattern.test(unit))
		const start = match.index ?? 0
		return {
			ms:
				Number(match[1]) *
				Option.getOrElse(
					Option.map(size, ([, ms]) => ms),
					() => 0,
				),
			start,
			end: start + match[0].length,
		}
	})
	const totals: Array<number> = []
	let previousEnd = -1
	Arr.forEach(parts, (part) => {
		const last = totals.length - 1
		if (last >= 0 && previousEnd >= 0 && JOINER.test(Str.slice(previousEnd, part.start)(text))) {
			totals[last] = (totals[last] ?? 0) + part.ms
		} else {
			totals.push(part.ms)
		}
		previousEnd = part.end
	})
	return totals
}

/** A call as the model made it, plus how the registry reads it. */
export interface ObservedCall {
	readonly tool: string
	readonly raw: unknown
	/** Arguments after alias and enum normalization; empty for an unknown tool. */
	readonly args: Readonly<Record<string, unknown>>
	/** Unknown tool, unknown keys, or arguments that do not decode. */
	readonly invalid: boolean
	readonly isError: boolean
}

export const observeCall = (tool: string, raw: unknown, isError: boolean): ObservedCall => {
	const read = readToolCall(tool, raw)
	if (read === undefined) return { tool, raw, args: {}, invalid: true, isError }
	// The registry resolves a family's `action` away; a target names it like any other argument.
	const args = read.action === undefined ? read.args : { action: read.action, ...read.args }
	return { tool, raw, args, invalid: !read.decodes || read.unknown.length > 0, isError }
}

export interface CheckResult {
	readonly pass: boolean
	readonly detail: string
}

const norm = (value: Scalar): string =>
	typeof value === "string" ? Str.toLowerCase(Str.trim(value)) : String(value)

const scalarEquals = (expected: Scalar, actual: unknown): boolean => {
	if (Arr.isArray(actual)) return actual.length === 1 && scalarEquals(expected, actual[0])
	if (typeof expected === "number") return actual !== "" && Number(actual) === expected
	if (typeof expected === "boolean") return actual === expected || actual === String(expected)
	return typeof actual === "string" && norm(actual) === norm(expected)
}

const argMatches = (expectation: ArgExpectation, actual: unknown): boolean => {
	const present = actual !== undefined && actual !== null
	if (typeof expectation !== "object") return present && scalarEquals(expectation, actual)
	if ("absent" in expectation) return !present
	if ("present" in expectation) return present
	if ("oneOf" in expectation)
		return present && Arr.some(expectation.oneOf, (value) => scalarEquals(value, actual))
	if ("orDefault" in expectation) return !present || scalarEquals(expectation.orDefault, actual)
	// A JSON-typed parameter arrives as a string or already structured; both read as text here.
	const text = typeof actual === "string" ? actual : present ? (stringifyJson(actual) ?? "") : ""
	return present && Str.includes(Str.toLowerCase(expectation.includes))(Str.toLowerCase(text))
}

const callMatches = (expectation: CallExpectation, observed: ObservedCall): boolean =>
	observed.tool === expectation.tool &&
	Arr.every(Rec.toEntries(expectation.args ?? {}), ([key, value]) => argMatches(value, observed.args[key]))

const describeExpectation = (expectation: CallExpectation): string =>
	`${expectation.tool}(${Arr.join(
		Arr.map(Rec.toEntries(expectation.args ?? {}), ([key, value]) => `${key}=${showJson(value)}`),
		", ",
	)})`

export const describeCall = (observed: ObservedCall): string =>
	`${observed.tool}(${showJson(observed.args)})${observed.invalid ? " [invalid]" : ""}${observed.isError ? " [error]" : ""}`

export const runCheck = (
	check: Check,
	observed: ReadonlyArray<ObservedCall>,
	answer: string,
): CheckResult => {
	switch (check.kind) {
		case "calls": {
			const pass = Arr.some(observed, (made) =>
				Arr.some(check.anyOf, (expectation) => callMatches(expectation, made)),
			)
			return {
				pass,
				detail: pass
					? `matched one of ${Arr.join(Arr.map(check.anyOf, describeExpectation), " | ")}`
					: `wanted one of ${Arr.join(Arr.map(check.anyOf, describeExpectation), " | ")}`,
			}
		}
		case "never": {
			const offending = Arr.filter(observed, (made) => check.tools.includes(made.tool))
			return {
				pass: offending.length === 0,
				detail:
					offending.length === 0
						? `avoided ${Arr.join(check.tools, ", ")}`
						: `called ${Arr.join(
								Arr.map(offending, (made) => made.tool),
								", ",
							)}, which it must not`,
			}
		}
		case "no-tools":
			return {
				pass: observed.length === 0,
				detail:
					observed.length === 0 ? "answered without tools" : `called ${observed.length} tool(s)`,
			}
		case "answer-mentions": {
			const lower = Str.toLowerCase(answer)
			const hit = Arr.findFirst(check.anyOf, (term) => Str.includes(Str.toLowerCase(term))(lower))
			return {
				pass: Option.isSome(hit),
				detail: Option.match(hit, {
					onNone: () => `answer names none of ${showJson(check.anyOf)}`,
					onSome: (term) => `answer names "${term}"`,
				}),
			}
		}
		case "answer-number": {
			const { plain, percents } = numbersIn(answer)
			const wanted = check.percent === true ? check.value * 100 : check.value
			const pass =
				check.percent === true
					? // A share rounded to a whole percent is still the right share.
						Arr.some(percents, (stated) => Math.abs(stated - wanted) <= 0.5)
					: Arr.some(plain, (stated) => stated === wanted)
			const shown = check.percent === true ? `${Math.round(wanted * 100) / 100}%` : String(wanted)
			return {
				pass,
				detail: pass
					? `answer states ${check.label} = ${shown}`
					: `answer does not state ${check.label} = ${shown}`,
			}
		}
		case "answer-duration": {
			const pass = Arr.some(
				durationsIn(answer),
				(stated) => Math.abs(stated - check.ms) <= check.ms * check.tolerance,
			)
			const shown = `${Math.round(check.ms / 1_000)}s`
			return {
				pass,
				detail: pass
					? `answer states ${check.label} near ${shown}`
					: `answer does not state ${check.label} near ${shown}`,
			}
		}
	}
}

export interface Grade {
	readonly pass: boolean
	/** Fraction of checks passed: partial credit for the report, never for pass/fail. */
	readonly score: number
	readonly checks: ReadonlyArray<CheckResult>
	readonly explanation: string
}

export const grade = (
	checks: ReadonlyArray<Check>,
	observed: ReadonlyArray<ObservedCall>,
	answer: string,
): Grade => {
	const results = Arr.map(checks, (check) => runCheck(check, observed, answer))
	const passed = Arr.filter(results, (result) => result.pass).length
	const made = observed.length === 0 ? "no calls" : Arr.join(Arr.map(observed, describeCall), "; ")
	return {
		pass: passed === results.length,
		score: results.length === 0 ? 1 : passed / results.length,
		checks: results,
		explanation: `${Arr.join(
			Arr.map(results, (result) => `${result.pass ? "ok" : "FAIL"}: ${result.detail}`),
			"\n",
		)}\ncalls: ${made}`,
	}
}
