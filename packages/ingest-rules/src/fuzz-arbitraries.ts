import {
	ingestRuleProblems,
	IngestRuleDetector,
	type IngestRuleCondition,
	type IngestRuleField,
	IngestRuleScope,
	type IngestRuleSignal,
	type IngestRuleSpec,
	INGEST_RULE_LIMITS,
	opsForField,
	regexProblem,
	SEVERITY_LEVELS,
	signalsForField,
	SPAN_KINDS,
	SPAN_STATUSES,
} from "@maple/domain/ingest-rules"
import { Arbitrary, Schema } from "effect"
import { present, type FixtureCase } from "./conformance"

type Json = Schema.Json

// Random rules and records for the invariant tests and the differential fuzzer. Values come from
// small shared pools so conditions and keys hit often; the pools are full of the text that
// separates the engines: PII near the scan cap, non-ASCII digits and letters, line separators.

const int = (minimum: number, maximum: number) =>
	Arbitrary.schema(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum, maximum })))

const oneOf = <A>(...choices: ReadonlyArray<Arbitrary.Arbitrary<A>>): Arbitrary.Arbitrary<A> =>
	Arbitrary.flatMap(int(0, choices.length - 1), (index) => choices[index])

const element = <A>(items: ReadonlyArray<A>): Arbitrary.Arbitrary<A> =>
	Arbitrary.map(int(0, items.length - 1), (index) => items[index])

/** A subset of `items`, in their order, with at least `min` of them. */
const subset = <A>(items: ReadonlyArray<A>, min = 0): Arbitrary.Arbitrary<Array<A>> =>
	Arbitrary.filter(
		Arbitrary.map(
			Arbitrary.array(Arbitrary.schema(Schema.Boolean), {
				minLength: items.length,
				maxLength: items.length,
			}),
			(picks) => items.filter((_, index) => picks[index] === true),
		),
		(picked) => picked.length >= min,
	)

const optional = <A>(arb: Arbitrary.Arbitrary<A>): Arbitrary.Arbitrary<A | undefined> =>
	oneOf<A | undefined>(Arbitrary.Constant(undefined), arb)

export const SERVICES = ["api", "checkout", "web", "API", ""] as const
export const NAMES = ["GET /health", "GET /users/42", "db.query", "cpu.usage", "health"] as const

/** Keys records carry; protected ones are here so tests can prove no rule touches them. */
export const KEYS = [
	"user.email",
	"user.id",
	"password",
	"Password",
	"http.request.header.authorization",
	"db.statement",
	"card",
	"token",
	"exception.message",
	"maple_ai.prompt",
	"service.name",
	"org_id",
	"maple_org_id",
	"maple_source_id",
	"PASSWORD",
	"İD",
	"ΣΑΣ.token",
	"user.ſecret",
	"Key",
] as const

const KEY_GLOBS = [
	"user.*",
	"*password*",
	"*",
	"maple_*",
	"*.name",
	"http.request.header.*",
	"token",
	"*_id",
	"i̇d",
	"σας.*",
	"*secret*",
	"key",
]

const PII = [
	"jane.doe+x@example.co.uk",
	"a@b.co",
	"4111 1111 1111 1111",
	"4111111111111112",
	"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123",
	"sk_live_abcdefghijklmnop1234",
	"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
	"AKIAIOSFODNN7EXAMPLE",
	"Bearer abcdefghijkl",
	"192.168.0.1",
	"999.1.1.1",
	"2001:db8::1",
	"::1",
	"+1 (415) 555-0132",
	"GB82WEST12345698765432",
	"DE89370400440532013000",
]

const PLAIN = [
	"SS",
	"ς",
	"Σ",
	"ſ",
	"\u212a",
	"İ",
	"ﬁ",
	"Ⅻ",
	"²",
	"\u200d",
	"\ufeff",
	"\u0085",
	"",
	" ",
	"ok",
	"ORD-123",
	"x.y",
	"ab",
	"a1",
	"health",
	"GET /health",
	"straße",
	"ÉCOLE",
	"naïve 日本 😀",
	"٣٤٥",
	"١٢٣٤٥٦٧٨٩٠١٢",
	"é",
	"\r",
	"\n",
	" ",
	"\t",
	"K",
	"_",
]

const SEPARATORS = ["", " ", ",", "\n", "=", "/", ":", " "]

/** Short text made of PII and plain fragments, so detectors, patterns and conditions all hit. */
const shortText = Arbitrary.map(
	Arbitrary.all([
		Arbitrary.array(oneOf(element(PII), element(PLAIN)), { minLength: 0, maxLength: 4 }),
		element(SEPARATORS),
	]),
	([parts, separator]) => parts.join(separator),
)

/** Text that straddles the scan cap, with multi-byte filler so byte and UTF-16 counts differ. */
const longText = Arbitrary.map(
	Arbitrary.all([element(["a", "é", "日", "😀", "a b "]), int(-40, 40), element(PII)]),
	([filler, offset, secret]) => {
		const target = INGEST_RULE_LIMITS.scanBytes + offset
		const head = [...filler.repeat(target)].slice(0, target).join("")
		return `${head}${secret} tail`
	},
)

/** OTLP strings are UTF-8, so lone surrogates never reach either engine. */
const wellFormed = (value: string) => value.replace(/\p{Cs}/gu, "\ufffd")

export const text: Arbitrary.Arbitrary<string> = oneOf(
	shortText,
	shortText,
	shortText,
	longText,
	Arbitrary.map(Arbitrary.schema(Schema.String), wellFormed),
)

const scalar: Arbitrary.Arbitrary<Json> = oneOf<Json>(
	text,
	text,
	int(-1_000_000, 1_000_000),
	element([0.5, -2.25, 1.5e-7, 1e21, 123456.789]),
	Arbitrary.schema(Schema.Boolean),
	Arbitrary.map(element(["", "00ff", "6a616e65406578616d706c652e636f6d"]), (hex) => ({ $bytes: hex })),
)

const valueAt = (depth: number): Arbitrary.Arbitrary<Json> =>
	depth === 0
		? scalar
		: oneOf<Json>(
				scalar,
				scalar,
				scalar,
				Arbitrary.array(valueAt(depth - 1), { maxLength: 3 }),
				Arbitrary.map(
					Arbitrary.array(Arbitrary.all([element(KEYS), valueAt(depth - 1)]), { maxLength: 3 }),
					(entries) => Object.fromEntries(entries),
				),
			)

const attributes = Arbitrary.map(
	Arbitrary.array(Arbitrary.all([element(KEYS), valueAt(2)]), { maxLength: 5 }),
	(entries) => Object.fromEntries(entries),
)

const resource = Arbitrary.map(
	Arbitrary.all([
		element(SERVICES),
		Arbitrary.array(Arbitrary.all([element(KEYS), scalar]), { maxLength: 3 }),
	]),
	([service, entries]) => ({ ...Object.fromEntries(entries), "service.name": service }),
)

const traceId = oneOf(
	Arbitrary.map(Arbitrary.array(int(0, 255), { minLength: 16, maxLength: 16 }), (bytes) =>
		bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(""),
	),
	Arbitrary.Constant("0AF7651916CD43DD8448EB211C80319C"),
)

const SEVERITIES = Object.entries(SEVERITY_LEVELS).map(([text, number]) => ({
	text: text.toUpperCase(),
	number,
}))

/** A record of one signal, in the fixture `input` form. */
export const recordOf = (signal: IngestRuleSignal): Arbitrary.Arbitrary<{ readonly [key: string]: Json }> => {
	if (signal === "logs")
		return Arbitrary.map(
			Arbitrary.all([
				resource,
				attributes,
				optional(valueAt(1)),
				element(SEVERITIES),
				optional(traceId),
			]),
			([res, attrs, body, severity, trace]) =>
				present([
					["signal", signal],
					["resource", res],
					["attributes", attrs],
					["severityNumber", severity.number],
					["severityText", severity.text],
					["body", body],
					["traceId", trace],
				]),
		)
	if (signal === "traces")
		return Arbitrary.map(
			Arbitrary.all([
				resource,
				attributes,
				element(NAMES),
				traceId,
				element(SPAN_KINDS),
				element(SPAN_STATUSES),
				optional(text),
				optional(
					Arbitrary.array(Arbitrary.all([element(["exception", "log"]), attributes]), {
						maxLength: 2,
					}),
				),
			]),
			([res, attrs, name, trace, kind, status, message, events]) =>
				present([
					["signal", signal],
					["resource", res],
					["attributes", attrs],
					["name", name],
					["traceId", trace],
					["spanKind", kind],
					["spanStatus", status],
					["statusMessage", message],
					[
						"events",
						events?.map(([eventName, eventAttributes]) => ({
							name: eventName,
							attributes: eventAttributes,
						})),
					],
				]),
		)
	return Arbitrary.map(Arbitrary.all([resource, attributes, element(NAMES)]), ([res, attrs, name]) => ({
		signal,
		resource: res,
		attributes: attrs,
		name,
	}))
}

const ATOMS = [
	"a",
	"b",
	"x",
	"k",
	"s",
	"σ",
	"[a-z]",
	"[0-9]",
	"[A-Z]",
	"[à-ÿ]",
	"[^a-z]",
	"\\d",
	"\\D",
	"\\w",
	"\\W",
	"\\s",
	"\\S",
	"\\b",
	"\\B",
	".",
	"é",
	"ß",
	"\\.",
	"@",
	"-",
	"日",
	"[^ ]",
	"\\p{L}",
	"\\p{Lu}",
	"\\P{L}",
	"[\\d_]",
	"[\\w.]",
	"\\u{1F600}",
	"\\x41",
	"(a|b)",
	"(?:x|yz)",
]
const QUANTIFIERS = ["", "", "+", "*", "?", "{2}", "{1,3}", "{0,64}", "{3,}", "*?"]

/** Regexes in the portable subset, half hand-written and half from a small grammar. */
export const pattern: Arbitrary.Arbitrary<string> = Arbitrary.filter(
	oneOf(
		element([
			"ORD-[0-9]+",
			"[a-z]+@[a-z]+",
			"(?i)secret",
			"\\d{3}",
			"a|b",
			"^GET",
			"health$",
			"(?i)k",
			"\\w+",
			"\\bab\\b",
			"x.y",
			"[^@]+@",
		]),
		Arbitrary.map(
			Arbitrary.all([
				element(["", "", "^", "(?i)"]),
				Arbitrary.array(Arbitrary.all([element(ATOMS), element(QUANTIFIERS)]), {
					minLength: 1,
					maxLength: 6,
				}),
				element(["", "", "$"]),
			]),
			([lead, pieces, tail]) =>
				`${lead}${pieces.map(([atom, quantifier]) => atom + quantifier).join("")}${tail}`,
		),
		// Two repetitions then a character the text lacks: the shape that backtracks for minutes.
		Arbitrary.map(
			Arbitrary.all([
				element(ATOMS),
				element(["*", "+", "{3,}", "{0,64}"]),
				element(ATOMS),
				element(["*", "+", "{3,}", "{0,64}"]),
				element(["!", "#", "b", "=", ""]),
			]),
			([first, firstQuantifier, second, secondQuantifier, end]) =>
				`${first}${firstQuantifier}${second}${secondQuantifier}${end}`,
		),
	),
	(source) => regexProblem(source) === null,
)

const FIELDS: ReadonlyArray<IngestRuleField> = [
	"service_name",
	"name",
	"attribute",
	"resource_attribute",
	"body",
	"severity",
	"span_kind",
	"span_status",
]

const operand = (field: IngestRuleField): Arbitrary.Arbitrary<string> => {
	if (field === "service_name") return element(SERVICES)
	if (field === "name") return element(NAMES)
	if (field === "severity") return element(Object.keys(SEVERITY_LEVELS))
	if (field === "span_kind") return element(SPAN_KINDS)
	if (field === "span_status") return element(SPAN_STATUSES)
	return oneOf(element(PII), element(PLAIN), element(["a@", "4111", "sk_", "GET", "1", "true"]))
}

const conditionFor = (signals: ReadonlyArray<IngestRuleSignal>): Arbitrary.Arbitrary<IngestRuleCondition> => {
	const fields = FIELDS.filter((field) =>
		signals.every((signal) => signalsForField(field).includes(signal)),
	)
	return Arbitrary.flatMap(element(fields), (field) =>
		Arbitrary.flatMap(
			Arbitrary.all([element(opsForField(field)), element(KEYS)]),
			([op, key]): Arbitrary.Arbitrary<IngestRuleCondition> => {
				const keyed: { readonly key?: string } =
					field === "attribute" || field === "resource_attribute" ? { key } : {}
				if (op === "exists" || op === "not_exists") return Arbitrary.Constant({ field, op, ...keyed })
				if (op === "in" || op === "not_in")
					return Arbitrary.map(
						Arbitrary.array(operand(field), { minLength: 1, maxLength: 3 }),
						(values): IngestRuleCondition => ({ field, op, values, ...keyed }),
					)
				return Arbitrary.map(
					op === "regex" ? pattern : operand(field),
					(value): IngestRuleCondition => ({ field, op, value, ...keyed }),
				)
			},
		),
	)
}

/** One valid rule, mostly over `signal`, so it has a fair chance to apply to the record. */
export const ruleFor = (signal: IngestRuleSignal): Arbitrary.Arbitrary<IngestRuleSpec> =>
	Arbitrary.filter(
		Arbitrary.flatMap(
			oneOf(
				Arbitrary.Constant<Array<IngestRuleSignal>>([signal]),
				subset<IngestRuleSignal>(["traces", "logs", "metrics"], 1),
			),
			(signals) =>
				oneOf<IngestRuleSpec>(
					Arbitrary.map(
						Arbitrary.all([
							Arbitrary.array(conditionFor(signals), { minLength: 1, maxLength: 3 }),
							oneOf(element([0, 100]), int(1, 99)),
						]),
						([conditions, keep]) => ({
							signals,
							conditions,
							action: { _tag: "drop", keepPercent: signals.includes("metrics") ? 0 : keep },
						}),
					),
					Arbitrary.map(
						Arbitrary.all([
							Arbitrary.array(conditionFor(signals), { maxLength: 2 }),
							Arbitrary.array(element(KEY_GLOBS), { maxLength: 3 }),
							subset(IngestRuleDetector.literals),
							Arbitrary.array(pattern, { maxLength: 2 }),
							subset(IngestRuleScope.literals, 1),
							element(["mask", "hash", "remove"] as const),
						]),
						([conditions, keys, detectors, patterns, scopes, method]) => ({
							signals,
							conditions,
							action: {
								_tag: "redact",
								keys,
								detectors:
									keys.length + patterns.length + detectors.length === 0
										? ["email"]
										: detectors,
								patterns,
								scopes: scopes
									.filter(
										(scope) =>
											(scope !== "body" || signals.includes("logs")) &&
											(scope !== "events" || signals.includes("traces")),
									)
									.concat(["attributes"])
									.filter((scope, index, all) => all.indexOf(scope) === index),
								method,
							},
						}),
					),
				),
		),
		(spec) => ingestRuleProblems(spec).length === 0,
	)

export interface FuzzCase extends FixtureCase {
	readonly rules: ReadonlyArray<IngestRuleSpec>
	readonly input: { readonly signal: IngestRuleSignal; readonly [key: string]: Json }
}

/** A case both engines can run: 1-4 rules over one record. */
export const fuzzCase: Arbitrary.Arbitrary<FuzzCase> = Arbitrary.flatMap(
	element(["traces", "logs", "metrics"] as const),
	(signal) =>
		Arbitrary.map(
			Arbitrary.all([
				Arbitrary.array(ruleFor(signal), { minLength: 1, maxLength: 4 }),
				recordOf(signal),
				element(["s", "fixture-salt"]),
			]),
			([rules, input, salt]) => ({
				name: "fuzz",
				salt,
				rules,
				input: { ...portable(rules, input), signal },
			}),
		),
)

/** Records without a trace id draw at random in the gateway, so give them one when a rule samples. */
const portable = (
	rules: ReadonlyArray<IngestRuleSpec>,
	input: { readonly [key: string]: Json },
): { readonly [key: string]: Json } => {
	const samples = rules.some(
		(rule) => rule.action._tag === "drop" && rule.action.keepPercent > 0 && rule.action.keepPercent < 100,
	)
	return samples && input.traceId === undefined
		? { ...input, traceId: "5b8efff798038103d269b633813fc60c" }
		: input
}
