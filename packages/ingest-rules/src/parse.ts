import {
	INGEST_RULE_LIMITS,
	PARSE_ERROR_KEY,
	isProtectedKey,
	parsePatternRegex,
	type IngestParseStep,
	type IngestTimestampFormat,
} from "@maple/domain/ingest-rules"
import type { GrokField } from "@maple/domain/ingest-grok"
import { Array as Arr, Option, Order, Record as Rec, Schema, String as Str } from "effect"
import { RE2JS } from "re2js"
import type { AttrMap, AttrValue, RuleRecord } from "./engine"
import { utf8 } from "./sha256"
import { comparable } from "./values"

// Parse rules: the TS twin of `apps/ingest/src/ingest_rules/parse.rs`. Semantics in
// docs/ingest-rules.md ("Parse rules"); the parse fixtures hold both engines to them.

type Source = { readonly source: "body" | "attribute"; readonly key?: string }

export type CompiledParseStep =
	| (Source & { readonly _tag: "json"; readonly prefix: string })
	| (Source & {
			readonly _tag: "regex" | "grok"
			readonly prefix: string
			readonly regex: RE2JS
			/** Group `groups[i]` fills `fields[i]`. */
			readonly groups: ReadonlyArray<string>
			readonly fields: ReadonlyArray<GrokField>
	  })
	| (Source & { readonly _tag: "severity" })
	| (Source & { readonly _tag: "timestamp"; readonly format: IngestTimestampFormat })

/** Steps of a rule that passed `ingestRuleProblems`; a pattern that still fails is dropped. */
export const compileParseSteps = (steps: ReadonlyArray<IngestParseStep>): ReadonlyArray<CompiledParseStep> =>
	Arr.flatMap(steps, (step): ReadonlyArray<CompiledParseStep> => {
		const key = step.key === undefined ? {} : { key: step.key }
		const source = { source: step.source, ...key }
		switch (step._tag) {
			case "json":
				return [{ ...source, _tag: "json", prefix: step.prefix ?? "" }]
			case "severity":
				return [{ ...source, _tag: "severity" }]
			case "timestamp":
				return [{ ...source, _tag: "timestamp", format: step.format }]
			case "regex":
			case "grok": {
				const expanded = parsePatternRegex(step)
				if (typeof expanded === "string") return []
				return [
					{
						...source,
						_tag: step._tag,
						prefix: step.prefix ?? "",
						regex: RE2JS.compile(expanded.regex),
						groups:
							step._tag === "grok"
								? Arr.map(expanded.fields, (_, index) => `g${index}`)
								: Arr.map(expanded.fields, (field) => field.name),
						fields: expanded.fields,
					},
				]
			}
		}
	})

export interface ParseOutcome {
	readonly record: RuleRecord
	/** `<step>: <reason>` of the first step that failed, or null. */
	readonly failure: string | null
	/** Attribute keys written from the body; body-scoped redaction covers them. */
	readonly bodyKeys: ReadonlyArray<string>
}

const isList = (value: AttrValue): value is ReadonlyArray<AttrValue> => Arr.isArray(value)
const isMap = (value: AttrValue): value is AttrMap =>
	typeof value === "object" && !isList(value) && !(value instanceof Uint8Array)

const ownValue = (map: AttrMap, key: string): AttrValue | undefined =>
	// @effect-diagnostics-next-line preferEffectRecord:off -- not a record type; Rec.has would need a cast
	Object.hasOwn(map, key) ? map[key] : undefined

const codePoints = (text: string): ReadonlyArray<number> =>
	Arr.map(Array.from(text), (char) => Option.getOrElse(Str.codePointAt(char, 0), () => 0))

/** Code point order, which is Rust's `str` order; UTF-16 order differs past U+FFFF. */
const byCodePoint: Order.Order<string> = (left, right) => {
	const a = codePoints(left)
	const b = codePoints(right)
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0)
		if (diff !== 0) return diff < 0 ? -1 : 1
	}
	return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/** Deepest nesting of `{` and `[` outside strings. */
const jsonDepth = (text: string): number => {
	let depth = 0
	let deepest = 0
	let inString = false
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]
		if (inString) {
			if (char === "\\") index += 1
			else if (char === '"') inString = false
		} else if (char === '"') inString = true
		else if (char === "{" || char === "[") deepest = Math.max(deepest, ++depth)
		else if (char === "}" || char === "]") depth -= 1
	}
	return deepest
}

const valueDepth = (value: AttrValue): number => {
	if (isList(value)) return 1 + Arr.reduce(value, 0, (deepest, item) => Math.max(deepest, valueDepth(item)))
	if (isMap(value))
		return 1 + Arr.reduce(Rec.values(value), 0, (deepest, item) => Math.max(deepest, valueDepth(item)))
	return 0
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER

/** A JSON value as an attribute value; null for JSON null. Whole numbers within 2^53 are ints. */
const fromJson = (json: unknown): AttrValue | null => {
	if (json === null) return null
	if (typeof json === "string" || typeof json === "boolean") return json
	if (typeof json === "number")
		return Number.isInteger(json) && Math.abs(json) <= MAX_SAFE ? BigInt(json) : json
	if (Arr.isArray(json))
		return Arr.flatMap(json, (item) => Option.toArray(Option.fromNullishOr(fromJson(item))))
	if (typeof json === "object")
		return Rec.fromEntries(
			Arr.flatMap(Rec.toEntries(json), ([key, item]) => {
				const value = fromJson(item)
				return value === null ? [] : [[key, value] as const]
			}),
		)
	return null
}

/** Flattens a map into dotted keys, visiting keys in code point order; arrays stay whole. */
const flatten = (map: AttrMap, path: string, out: Array<readonly [string, AttrValue]>): void => {
	for (const key of Arr.sort(
		Arr.map(Rec.toEntries(map), ([key]) => key),
		byCodePoint,
	)) {
		const value = ownValue(map, key)
		if (value === undefined) continue
		const full = path === "" ? key : `${path}.${key}`
		if (isMap(value)) flatten(value, full, out)
		else out.push([full, value])
	}
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

type StepResult =
	| { readonly _tag: "fields"; readonly fields: ReadonlyArray<readonly [string, AttrValue]> }
	| { readonly _tag: "severity"; readonly number: number; readonly text: string }
	| { readonly _tag: "time"; readonly nanos: bigint }
	| { readonly _tag: "failed"; readonly reason: string }

const failed = (reason: string): StepResult => ({ _tag: "failed", reason })

const runJson = (value: AttrValue): StepResult => {
	let map: AttrMap
	if (typeof value === "string") {
		if (utf8(value).length > INGEST_RULE_LIMITS.jsonBytes) return failed("larger than 64 KiB")
		if (jsonDepth(value) > INGEST_RULE_LIMITS.jsonDepth) return failed("nested deeper than 16 levels")
		const parsed = decodeJson(value)
		if (Option.isNone(parsed)) return failed("not valid JSON")
		const json = parsed.value
		if (typeof json !== "object" || json === null || Arr.isArray(json)) return failed("not an object")
		const converted = fromJson(json)
		map = converted !== null && isMap(converted) ? converted : {}
	} else if (isMap(value)) {
		if (valueDepth(value) > INGEST_RULE_LIMITS.jsonDepth) return failed("nested deeper than 16 levels")
		map = value
	} else return failed("source is not text or a map")
	const fields: Array<readonly [string, AttrValue]> = []
	flatten(map, "", fields)
	if (fields.length > INGEST_RULE_LIMITS.jsonFields) return failed("more than 128 fields")
	return { _tag: "fields", fields }
}

const INT_TEXT = /^[+-]?[0-9]+$/u
const FLOAT_TEXT = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u
const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n

/** A grok `:int` or `:float` capture; text that does not convert stays text. */
const typed = (text: string, type: GrokField["type"]): AttrValue => {
	if (type === "int" && INT_TEXT.test(text)) {
		const value = BigInt(text)
		return value >= I64_MIN && value <= I64_MAX ? value : text
	}
	if (type === "float" && FLOAT_TEXT.test(text)) {
		const value = Number(text)
		return Number.isFinite(value) ? value : text
	}
	return text
}

const runPattern = (
	step: Extract<CompiledParseStep, { readonly _tag: "regex" | "grok" }>,
	value: AttrValue,
	cut: (text: string) => number,
): StepResult => {
	if (typeof value !== "string") return failed("source is not text")
	const matcher = step.regex.matcher(Str.slice(0, cut(value))(value))
	if (!matcher.find()) return failed("no match")
	const fields = Arr.flatMap(step.fields, (field, index): ReadonlyArray<readonly [string, AttrValue]> => {
		const captured = matcher.group(step.groups[index] ?? "")
		return captured === null ? [] : [[field.name, typed(captured, field.type)]]
	})
	return { _tag: "fields", fields }
}

const SEVERITY_PREFIXES: ReadonlyArray<readonly [string, number]> = [
	["trace", 1],
	["debug", 5],
	["info", 9],
	["notice", 10],
	["warn", 13],
	["err", 17],
	["fatal", 21],
	["crit", 21],
	["alert", 21],
	["emerg", 21],
]

/** The OTel short name for a severity number. */
export const severityName = (number: number): string =>
	number <= 4
		? "TRACE"
		: number <= 8
			? "DEBUG"
			: number <= 12
				? "INFO"
				: number <= 16
					? "WARN"
					: number <= 20
						? "ERROR"
						: "FATAL"

const asciiLower = (text: string) =>
	Arr.join(
		Arr.map(Array.from(text), (char) => (char >= "A" && char <= "Z" ? Str.toLowerCase(char) : char)),
		"",
	)

const runSeverity = (value: AttrValue): StepResult => {
	const text = comparable(value)
	if (text === null) return failed("source is not text")
	const numeric = /^[0-9]{1,2}$/u.test(text) ? Number(text) : 0
	const number =
		numeric >= 1 && numeric <= 24
			? numeric
			: Option.match(
					Arr.findFirst(SEVERITY_PREFIXES, ([prefix]) => Str.startsWith(prefix)(asciiLower(text))),
					{ onNone: () => 0, onSome: ([, level]) => level },
				)
	return number === 0 ? failed("unknown level") : { _tag: "severity", number, text: severityName(number) }
}

const U64_MAX = 2n ** 64n - 1n
/** Fraction digits a unix format's unit has below one second; null for the date formats. */
const unixDigits = (format: IngestTimestampFormat): number | null =>
	format === "unix_s"
		? 9
		: format === "unix_ms"
			? 6
			: format === "unix_us"
				? 3
				: format === "unix_ns"
					? 0
					: null
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's `days_from_civil`). */
const daysFromCivil = (year: number, month: number, day: number): number => {
	const y = month <= 2 ? year - 1 : year
	const era = Math.floor(y / 400)
	const yoe = y - era * 400
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
	return era * 146_097 + doe - 719_468
}

const daysInMonth = (year: number, month: number): number =>
	month === 2
		? (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
			? 29
			: 28
		: [4, 6, 9, 11].includes(month)
			? 30
			: 31

/** Reads fixed-width ASCII digits; null when any is not a digit. */
const digitsAt = (text: string, at: number, width: number): number | null => {
	const slice = Str.slice(at, at + width)(text)
	return slice.length === width && /^[0-9]+$/u.test(slice) ? Number(slice) : null
}

interface Civil {
	readonly year: number
	readonly month: number
	readonly day: number
	readonly hour: number
	readonly minute: number
	readonly second: number
	readonly nanos: bigint
	readonly offsetMinutes: number
}

const civilNanos = (civil: Civil): bigint | "range" => {
	const valid =
		civil.month >= 1 &&
		civil.month <= 12 &&
		civil.day >= 1 &&
		civil.day <= daysInMonth(civil.year, civil.month) &&
		civil.hour <= 23 &&
		civil.minute <= 59 &&
		civil.second <= 59
	if (!valid) return "range"
	const seconds =
		daysFromCivil(civil.year, civil.month, civil.day) * 86_400 +
		civil.hour * 3600 +
		civil.minute * 60 +
		civil.second -
		civil.offsetMinutes * 60
	return seconds < 0 ? "range" : BigInt(seconds) * 1_000_000_000n + civil.nanos
}

/** `-HH:MM`, `+HHMM`, `Z` or nothing at `at`, as minutes east; null when malformed. */
const zoneAt = (text: string, at: number, colon: "optional" | "never"): number | null => {
	const rest = Str.slice(at)(text)
	if (rest === "") return colon === "optional" ? 0 : null
	if (colon === "optional" && (rest === "Z" || rest === "z")) return 0
	const sign = rest[0] === "+" ? 1 : rest[0] === "-" ? -1 : 0
	if (sign === 0) return null
	const hours = digitsAt(rest, 1, 2)
	const withColon = rest[3] === ":" && colon === "optional"
	const minutes = digitsAt(rest, withColon ? 4 : 3, 2)
	const length = withColon ? 6 : 5
	if (hours === null || minutes === null || rest.length !== length || hours > 23 || minutes > 59)
		return null
	return sign * (hours * 60 + minutes)
}

const parseRfc3339 = (text: string): Civil | null => {
	const year = digitsAt(text, 0, 4)
	const month = digitsAt(text, 5, 2)
	const day = digitsAt(text, 8, 2)
	const hour = digitsAt(text, 11, 2)
	const minute = digitsAt(text, 14, 2)
	const second = digitsAt(text, 17, 2)
	const separators =
		text[4] === "-" &&
		text[7] === "-" &&
		Str.includes(text[10] ?? "")("Tt ") &&
		text[13] === ":" &&
		text[16] === ":"
	if (!separators || year === null || month === null || day === null) return null
	if (hour === null || minute === null || second === null) return null
	let at = 19
	let nanos = 0n
	if (text[at] === "." || text[at] === ",") {
		const digits = /^[0-9]+/u.exec(Str.slice(at + 1)(text))?.[0] ?? ""
		if (digits === "") return null
		nanos = BigInt(Str.padEnd(9, "0")(Str.slice(0, 9)(digits)))
		at += 1 + digits.length
	}
	const offsetMinutes = zoneAt(text, at, "optional")
	return offsetMinutes === null ? null : { year, month, day, hour, minute, second, nanos, offsetMinutes }
}

const parseCommonLog = (text: string): Civil | null => {
	const day = digitsAt(text, 0, 2)
	const month = MONTHS.indexOf(Str.slice(3, 6)(text)) + 1
	const year = digitsAt(text, 7, 4)
	const hour = digitsAt(text, 12, 2)
	const minute = digitsAt(text, 15, 2)
	const second = digitsAt(text, 18, 2)
	const separators =
		text[2] === "/" &&
		text[6] === "/" &&
		text[11] === ":" &&
		text[14] === ":" &&
		text[17] === ":" &&
		text[20] === " "
	if (!separators || day === null || month === 0 || year === null) return null
	if (hour === null || minute === null || second === null) return null
	const offsetMinutes = zoneAt(text, 21, "never")
	return offsetMinutes === null
		? null
		: { year, month, day, hour, minute, second, nanos: 0n, offsetMinutes }
}

const parseUnix = (text: string, fractionDigits: number): bigint | "format" | "range" => {
	const match = /^([0-9]+)(?:\.([0-9]+))?$/u.exec(text)
	if (match === null) return "format"
	const whole = Str.replace(/^0+(?=[0-9])/u, "")(match[1] ?? "0")
	if (whole.length > 20) return "range"
	const fraction = Str.padEnd(fractionDigits, "0")(Str.slice(0, fractionDigits)(match[2] ?? ""))
	const nanos = BigInt(whole) * 10n ** BigInt(fractionDigits) + (fraction === "" ? 0n : BigInt(fraction))
	return nanos > U64_MAX ? "range" : nanos
}

const runTimestamp = (value: AttrValue, format: IngestTimestampFormat): StepResult => {
	const text = comparable(value)
	if (text === null) return failed("source is not text")
	const digits = unixDigits(format)
	const nanos =
		digits !== null
			? parseUnix(text, digits)
			: Option.match(
					Option.fromNullishOr(format === "rfc3339" ? parseRfc3339(text) : parseCommonLog(text)),
					{
						onNone: () => "format" as const,
						onSome: civilNanos,
					},
				)
	if (nanos === "format") return failed(`does not match ${format}`)
	if (nanos === "range") return failed("out of range")
	return { _tag: "time", nanos }
}

/** Runs one rule's steps in order on a record its conditions matched. */
export const runParse = (
	steps: ReadonlyArray<CompiledParseStep>,
	record: RuleRecord,
	cut: (text: string) => number,
): ParseOutcome => {
	let current = record
	let failure: string | null = null
	const bodyKeys: Array<string> = []
	for (const step of steps) {
		const value = step.source === "body" ? current.body : ownValue(current.attributes, step.key ?? "")
		const result: StepResult =
			value === undefined
				? failed("source is missing")
				: step._tag === "json"
					? runJson(value)
					: step._tag === "severity"
						? runSeverity(value)
						: step._tag === "timestamp"
							? runTimestamp(value, step.format)
							: runPattern(step, value, cut)
		switch (result._tag) {
			case "failed":
				failure ??= `${step._tag}: ${result.reason}`
				break
			case "severity":
				current = { ...current, severityNumber: result.number, severityText: result.text }
				break
			case "time":
				current = { ...current, timeUnixNano: result.nanos }
				break
			case "fields": {
				const prefix =
					step._tag === "json" || step._tag === "regex" || step._tag === "grok" ? step.prefix : ""
				const written = Arr.filter(
					Arr.map(result.fields, ([key, field]) => [`${prefix}${key}`, field] as const),
					([key]) => !isProtectedKey(key),
				)
				if (written.length === 0) break
				current = { ...current, attributes: { ...current.attributes, ...Rec.fromEntries(written) } }
				if (step.source === "body") bodyKeys.push(...Arr.map(written, ([key]) => key))
				break
			}
		}
	}
	if (failure !== null)
		current = { ...current, attributes: { ...current.attributes, [PARSE_ERROR_KEY]: failure } }
	return { record: current, failure, bodyKeys }
}
