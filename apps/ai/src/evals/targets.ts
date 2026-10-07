/**
 * What a trial has to achieve, and the deterministic grader that checks it.
 *
 * A task states acceptable outcomes, never one exact spelling. Every call is read through the
 * registry first (`readToolCall`), so a retired parameter name or a lowercase enum means what the
 * dispatcher would make of it. Expectations list every acceptable answer (BFCL's per-argument
 * value lists), and a call anywhere in the trajectory can satisfy them, not only the first.
 */
import { readToolCall } from "../mcp/tools/registry"

export type Scalar = string | number | boolean

/** One argument's acceptable values. A bare scalar means "equal to this". */
export type ArgExpectation =
	| Scalar
	| { readonly oneOf: ReadonlyArray<Scalar> }
	/** Equal to this, or omitted because this is the tool's default. */
	| { readonly orDefault: Scalar }
	/** Case-insensitive substring, for free text such as a search phrase. */
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

export const call = (tool: string, args?: CallExpectation["args"]): CallExpectation =>
	args === undefined ? { tool } : { tool, args }

export const calls = (...anyOf: ReadonlyArray<CallExpectation>): Check => ({ kind: "calls", anyOf })
export const never = (...tools: ReadonlyArray<string>): Check => ({ kind: "never", tools })
export const noTools: Check = { kind: "no-tools" }
export const answerMentions = (...anyOf: ReadonlyArray<string>): Check => ({ kind: "answer-mentions", anyOf })

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
	return read === undefined
		? { tool, raw, args: {}, invalid: true, isError }
		: { tool, raw, args: read.args, invalid: !read.decodes || read.unknown.length > 0, isError }
}

export interface CheckResult {
	readonly pass: boolean
	readonly detail: string
}

const norm = (value: Scalar): string =>
	typeof value === "string" ? value.trim().toLowerCase() : String(value)

const scalarEquals = (expected: Scalar, actual: unknown): boolean => {
	if (Array.isArray(actual)) return actual.length === 1 && scalarEquals(expected, actual[0])
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
		return present && expectation.oneOf.some((value) => scalarEquals(value, actual))
	if ("orDefault" in expectation) return !present || scalarEquals(expectation.orDefault, actual)
	return typeof actual === "string" && actual.toLowerCase().includes(expectation.includes.toLowerCase())
}

const callMatches = (expectation: CallExpectation, observed: ObservedCall): boolean =>
	observed.tool === expectation.tool &&
	Object.entries(expectation.args ?? {}).every(([key, value]) => argMatches(value, observed.args[key]))

const describeExpectation = (expectation: CallExpectation): string =>
	`${expectation.tool}(${Object.entries(expectation.args ?? {})
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(", ")})`

export const describeCall = (observed: ObservedCall): string =>
	`${observed.tool}(${JSON.stringify(observed.args)})${observed.invalid ? " [invalid]" : ""}${observed.isError ? " [error]" : ""}`

export const runCheck = (
	check: Check,
	observed: ReadonlyArray<ObservedCall>,
	answer: string,
): CheckResult => {
	switch (check.kind) {
		case "calls": {
			const pass = observed.some((made) =>
				check.anyOf.some((expectation) => callMatches(expectation, made)),
			)
			return {
				pass,
				detail: pass
					? `matched one of ${check.anyOf.map(describeExpectation).join(" | ")}`
					: `wanted one of ${check.anyOf.map(describeExpectation).join(" | ")}`,
			}
		}
		case "never": {
			const offending = observed.filter((made) => check.tools.includes(made.tool))
			return {
				pass: offending.length === 0,
				detail:
					offending.length === 0
						? `avoided ${check.tools.join(", ")}`
						: `called ${offending.map((made) => made.tool).join(", ")}, which it must not`,
			}
		}
		case "no-tools":
			return {
				pass: observed.length === 0,
				detail:
					observed.length === 0 ? "answered without tools" : `called ${observed.length} tool(s)`,
			}
		case "answer-mentions": {
			const lower = answer.toLowerCase()
			const hit = check.anyOf.find((term) => lower.includes(term.toLowerCase()))
			return {
				pass: hit !== undefined,
				detail:
					hit !== undefined
						? `answer names "${hit}"`
						: `answer names none of ${JSON.stringify(check.anyOf)}`,
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
	const results = checks.map((check) => runCheck(check, observed, answer))
	const passed = results.filter((result) => result.pass).length
	const made = observed.length === 0 ? "no calls" : observed.map(describeCall).join("; ")
	return {
		pass: passed === results.length,
		score: results.length === 0 ? 1 : passed / results.length,
		checks: results,
		explanation: `${results.map((result) => `${result.pass ? "ok" : "FAIL"}: ${result.detail}`).join("\n")}\ncalls: ${made}`,
	}
}
