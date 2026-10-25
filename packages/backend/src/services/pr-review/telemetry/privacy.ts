/**
 * Secrets and personal data a pull request hands to telemetry, found without a model: added lines
 * that put a sensitive name or a recognizable value into a span attribute, a span event or a log.
 * What a name cannot show (a whole object, a message built from input) is the reviewer's to find.
 */
import { PrReviewFinding, type PrReviewSeverity, type PullRequestFile } from "@maple/domain/http"
import { SEVERITY_RANK } from "../findings"
import {
	type DiffLine,
	isCommentLine,
	isLogCall,
	isRuntimeSource,
	parsePatch,
	SPAN_CALL,
	STRING_LITERAL,
} from "./diff"

export type PrivacyKind = "secret" | "government_id" | "payment" | "contact" | "network" | "payload"

type Sink = "log" | "attribute" | "event"

/** Calls that put a value on a span, a span event or a log record's attributes. */
const ATTRIBUTE_SINK =
	/(?:setAttributes?|set_attributes?|annotateCurrentSpan|annotateSpans|annotateLogs|setTag|set_tag|\battributes\s*[:=]|\battribute\.(?:String|Int|Int64|Bool|Float64|StringSlice)\s*\(|\bzap\.(?:String|Any|Stringer|Reflect)\s*\(|\bslog\.(?:String|Any|Group)\s*\(|#\[instrument\(|\bfields\()/
const EVENT_SINK = /(?:addEvent|add_event)\s*\(/
/** Log calls `isLogCall` does not know: Rust's tracing macros, Go loggers, logrus fields. */
const MORE_LOGS =
	/(?:\b(?:info|warn|error|debug|trace|event)!\s*\(|\blogger\.(?:log|exception|critical|fatal)\s*\(|\blog\.(?:Info|Warn|Error|Debug|Printf|Println|Fatalf?)\s*\(|\bWithFields?\s*\()/

/** A line that passes the value through a redaction or a one-way transform first. */
const TRANSFORMED_LINE =
	/\b(?:redact\w*|mask\w*|hash\w*|sha(?:1|256|512)\w*|digest|anonymi[sz]e\w*|obfuscat\w*|scrub\w*|truncate\w*|Redacted\.make)\s*\(/i

/** Words that make a name about the value, not the value: `hashedPassword`, `hasToken`, `maxTokens`. */
const NOT_THE_VALUE = new Set([
	"hash",
	"hashed",
	"encrypted",
	"masked",
	"redacted",
	"sanitized",
	"anonymized",
	"obfuscated",
	"truncated",
	"has",
	"is",
	"should",
	"can",
	"max",
	"min",
	"num",
	"total",
])

/** Words after the match that name metadata about it: `tokenCount`, `emailVerified`, `cookieName`. */
const META_WORDS = new Set([
	"scope",
	"scopes",
	"subject",
	"prompt",
	"completion",
	"limit",
	"usage",
	"introspection",
	"verdict",
	"result",
	"outcome",
	"state",
	"validation",
	"reason",
	"age",
	"issuer",
	"audience",
	"algorithm",
	"lifetime",
	"details",
	"destination",
	"destinations",
	"updated",
	"changed",
	"delivered",
	"failed",
	"attempts",
	"retries",
	"cache",
	"hit",
	"miss",
	"rejected",
	"accepted",
	"looks",
	"used",
	"last",
	"created",
	"revoked",
	"rotated",
	"count",
	"length",
	"len",
	"size",
	"id",
	"ids",
	"type",
	"kind",
	"name",
	"names",
	"verified",
	"enabled",
	"required",
	"present",
	"exists",
	"valid",
	"configured",
	"set",
	"status",
	"domain",
	"provider",
	"expires",
	"expiry",
	"ttl",
	"prefix",
	"suffix",
	"last4",
	"source",
	"mode",
	"policy",
	"format",
	"version",
	"field",
	"fields",
	"service",
	"client",
	"template",
	"queue",
	"job",
	"config",
	"url",
	"path",
	"error",
	"errors",
	"schema",
	"sent",
	"ref",
	"refs",
	"arn",
	"store",
	"vault",
	"manager",
	"rotation",
])

/** Single words, matched whole: `token` but not `tokens` (`gen_ai.usage.output_tokens`). */
const WORDS = new Map<string, PrivacyKind>([
	["password", "secret"],
	["passwd", "secret"],
	["passphrase", "secret"],
	["secret", "secret"],
	["token", "secret"],
	["credential", "secret"],
	["credentials", "secret"],
	["authorization", "secret"],
	["cookie", "secret"],
	["cookies", "secret"],
	["bearer", "secret"],
	["ssn", "government_id"],
	["passport", "government_id"],
	["cvv", "payment"],
	["cvc", "payment"],
	["iban", "payment"],
	["email", "contact"],
	["phone", "contact"],
	["surname", "contact"],
	["dob", "contact"],
	["birthday", "contact"],
	["birthdate", "contact"],
	["ip", "network"],
])

/** Two or three adjacent words, squashed: `api_key`, `privateKey`, `x-forwarded-for`. */
const COMPOUNDS = new Map<string, PrivacyKind>([
	["apikey", "secret"],
	["privatekey", "secret"],
	["secretkey", "secret"],
	["accesskey", "secret"],
	["signingkey", "secret"],
	["clientsecret", "secret"],
	["accesstoken", "secret"],
	["refreshtoken", "secret"],
	["sessiontoken", "secret"],
	["idtoken", "secret"],
	["setcookie", "secret"],
	["authheader", "secret"],
	["socialsecurity", "government_id"],
	["taxid", "government_id"],
	["nationalid", "government_id"],
	["driverslicense", "government_id"],
	["driverlicense", "government_id"],
	["creditcard", "payment"],
	["cardnumber", "payment"],
	["accountnumber", "payment"],
	["routingnumber", "payment"],
	["bankaccount", "payment"],
	["firstname", "contact"],
	["lastname", "contact"],
	["fullname", "contact"],
	["legalname", "contact"],
	["phonenumber", "contact"],
	["dateofbirth", "contact"],
	["streetaddress", "contact"],
	["homeaddress", "contact"],
	["billingaddress", "contact"],
	["shippingaddress", "contact"],
	["postalcode", "contact"],
	["zipcode", "contact"],
	["ipaddress", "network"],
	["remoteaddr", "network"],
	["clientip", "network"],
	["xforwardedfor", "network"],
	["xrealip", "network"],
])

/** Owners whose name, email or address is not a person's: `repoFullName`, `support.email`. */
const NOT_A_PERSON = new Set([
	"repo",
	"repository",
	"project",
	"org",
	"organization",
	"package",
	"service",
	"file",
	"branch",
	"team",
	"workspace",
	"app",
	"metric",
	"table",
	"host",
	"model",
	"vcs",
	"git",
	"commit",
	"job",
	"dataset",
	"bucket",
	"image",
	"container",
	"queue",
	"topic",
	"sender",
	"support",
	"noreply",
	"system",
])

/** Containers whose whole contents are whatever the caller sent. */
const PAYLOAD_WORDS = new Set(["body", "rawbody", "headers"])

/** A name's words: split on separators and camelCase, lowercased. */
const wordsOf = (name: string): ReadonlyArray<string> =>
	name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0)

/** The first sensitive word or compound in a name, and the words it spans. */
const firstMatch = (words: ReadonlyArray<string>) => {
	for (let start = 0; start < words.length; start++) {
		for (const span of [3, 2]) {
			const kind =
				start + span <= words.length
					? COMPOUNDS.get(words.slice(start, start + span).join(""))
					: undefined
			if (kind !== undefined) return { kind, start, end: start + span }
		}
		const kind = WORDS.get(words[start] ?? "")
		if (kind !== undefined) return { kind, start, end: start + 1 }
	}
	return undefined
}

/**
 * What a key or an expression (`{ chain: true }`, which alone can be a whole payload) names. A
 * metadata word after the match (`token.count`) or a non-person owner before contact data
 * (`repo.fullName`) makes it not sensitive.
 */
export const classifyName = (
	name: string,
	options: { readonly chain?: boolean } = {},
): PrivacyKind | undefined => {
	const words = wordsOf(name)
	const last = words.at(-1)
	if (last === undefined || words.some((word) => NOT_THE_VALUE.has(word))) return undefined
	const match = firstMatch(words)
	if (match === undefined)
		return options.chain === true && words.length > 1 && PAYLOAD_WORDS.has(last) ? "payload" : undefined
	if (words.slice(match.end).some((word) => META_WORDS.has(word))) return undefined
	if (match.kind === "contact" && words.slice(0, match.start).some((word) => NOT_A_PERSON.has(word)))
		return undefined
	return match.kind
}

/** Values recognizable by their shape alone, wherever a telemetry call carries them. */
const VALUE_PATTERNS: ReadonlyArray<{
	readonly kind: PrivacyKind
	readonly label: string
	readonly pattern: RegExp
}> = [
	{ kind: "secret", label: "a JSON web token", pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/ },
	{ kind: "secret", label: "a private key", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
	{
		kind: "secret",
		label: "an API key",
		pattern: /\b(?:sk_live_\w{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|xox[abpr]-[\w-]{10,})/,
	},
	{ kind: "government_id", label: "a social security number", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
]

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g
/** Card networks' leading digits, so a long numeric id is not read as a card. */
const CARD_ISSUER = /^(?:4|5[1-5]|2[2-7]|3[47]|6011|65)/

/** Whether a digit string passes the Luhn check card numbers carry. */
const luhn = (digits: string): boolean =>
	[...digits].reverse().reduce((sum, char, i) => {
		const doubled = Number(char) * (i % 2 === 1 ? 2 : 1)
		return sum + (doubled > 9 ? doubled - 9 : doubled)
	}, 0) %
		10 ===
	0

const hasCardNumber = (text: string): boolean =>
	[...text.matchAll(CARD_CANDIDATE)].some((match) => {
		const digits = match[0].replace(/\D/g, "")
		return digits.length >= 13 && digits.length <= 19 && CARD_ISSUER.test(digits) && luhn(digits)
	})

const INTERPOLATION = /\$\{([^}]*)\}/g
const PY_INTERPOLATION = /\{([^{}]*)\}/g
const IDENTIFIER_CHAIN = /[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*/g
/** `req.headers["x-api-key"]`: blanking literals would drop the key, so it is read on the raw line. */
const BRACKET_ACCESS = /([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\[["']([\w.-]+)["']\]/g
/** A literal short and spaceless enough to be an attribute key or a header name. */
const KEY_LITERAL = /^[A-Za-z_][\w.-]{1,63}$/
/** Longer lines are generated or minified code, and are not scanned. */
const MAX_LINE_CHARS = 1000

interface LineLiteral {
	readonly value: string
	readonly offset: number
	/** An object key (`"k": v`), or a call's first argument followed by its value (`set("k", v)`). */
	readonly key: "object" | "argument" | undefined
}

/**
 * A line's string literals, and its code with each literal blanked to spaces of the same length,
 * interpolations (`${a}`, a Python f-string's `{a}`) left in place, so offsets match the line.
 */
const blankLiterals = (text: string) => {
	const literals: Array<LineLiteral> = []
	const interpolations: Array<readonly [number, number]> = []
	const code = text.replace(
		STRING_LITERAL,
		(whole: string, quote: string, value: string, offset: number) => {
			const before = text.slice(Math.max(0, offset - 200), offset)
			const after = text.slice(offset + whole.length, offset + whole.length + 4)
			// A key leads its value: `"k": v`, `set("k", v)`, Go's `slog.Info("msg", "k", v)`, or a
			// key alone on its line inside a call opened above.
			const key = SPAN_CALL.test(before)
				? undefined
				: /^\s*:/.test(after)
					? "object"
					: /(?:\(|,|^)\s*$/.test(before) && /^\s*,/.test(after)
						? "argument"
						: undefined
			literals.push({ value, offset, key })
			const pattern =
				quote === "`"
					? INTERPOLATION
					: /\b[rRbB]?[fF][rRbB]?$/.test(before)
						? PY_INTERPOLATION
						: undefined
			const blank = Array.from(whole, () => " ")
			for (const match of pattern === undefined ? [] : value.matchAll(pattern)) {
				const inner = match[1] ?? ""
				const at = 1 + (match.index ?? 0) + match[0].indexOf(inner)
				blank.splice(at, inner.length, ...inner)
				interpolations.push([offset + at, offset + at + inner.length])
			}
			return blank.join("")
		},
	)
	return { literals, code, interpolations }
}

/** The comma-separated entries of a line's code, as `[start, end)` offsets. */
const segmentsOf = (code: string): ReadonlyArray<readonly [number, number]> => {
	const bounds = [-1, ...[...code.matchAll(/,/g)].map((match) => match.index ?? 0), code.length]
	return bounds.slice(1).map((end, i) => [(bounds[i] ?? -1) + 1, end] as const)
}

/**
 * An entry whose recorded value is derived, not the data: a comparison, a negation, a presence
 * check, a length, or a constant (`hasToken: token !== undefined`, `"cache": "hit"`).
 */
const DERIVED_VALUE =
	/(?:[!=]==?|\bOption\.is(?:Some|None)\b|\.(?:length|size)\b|\bBoolean\(|\btypeof\b|(?:^|[(:])\s*!\s*[\w$]|(?:^|[(:])\s*(?:true|false|nil|-?\d+(?:\.\d+)?)[)}\];\s]*$|(?:^|[(:])\s*(["'])[^"'`$]*\1[)}\];\s]*$)/

/** Calls that hand their argument on unchanged, so what goes in still reaches the sink. */
const PASS_THROUGH =
	/^(?:JSON\.stringify|String|inspect|util\.inspect|format|util\.format|Redacted\.value|Option\.getOr\w+|encodeURIComponent|decodeURIComponent)$/

/** Identifier chains used as values or keys, with their offsets: `user.email`, not `sendEmail(`. */
const chainsOf = (code: string): ReadonlyArray<{ readonly chain: string; readonly offset: number }> =>
	[...code.matchAll(IDENTIFIER_CHAIN)]
		.filter((match) => {
			const at = match.index ?? 0
			const after = code.slice(at + match[0].length, at + match[0].length + 8)
			if (/^\s*\(/.test(after)) return /(?:^|\.)get[A-Z]\w*$/.test(match[0])
			// One indexed entry (`headers["x-github-event"]`), not the whole container.
			if (/^\s*\[/.test(after)) return false
			// An argument to a function that derives something from it (`fingerprintSql(body)`).
			const callee = /([\w$.]+)\(\s*$/.exec(code.slice(Math.max(0, at - 200), at))?.[1]
			return callee === undefined || sinkIn(`${callee}(`) !== undefined || PASS_THROUGH.test(callee)
		})
		.map((match) => ({ chain: match[0], offset: match.index ?? 0 }))

const sinkIn = (text: string): Sink | undefined =>
	isLogCall(text) || MORE_LOGS.test(text)
		? "log"
		: EVENT_SINK.test(text)
			? "event"
			: ATTRIBUTE_SINK.test(text)
				? "attribute"
				: undefined

/** The telemetry call a line is in: its own, or one opened above it in the same hunk. */
const sinkOf = (lines: ReadonlyArray<DiffLine>, index: number): Sink | undefined => {
	const line = lines[index]
	if (line === undefined) return undefined
	const direct = sinkIn(line.text)
	if (direct !== undefined) return direct
	let depth = 0
	for (let i = index - 1; i >= Math.max(0, index - 8); i--) {
		const above = lines[i]
		if (above === undefined || above.hunk !== line.hunk || above.text.length > MAX_LINE_CHARS)
			return undefined
		if (above.kind === "del") continue
		const opened = blankLiterals(above.text).code
		depth += (opened.match(/[({[]/g)?.length ?? 0) - (opened.match(/[)}\]]/g)?.length ?? 0)
		if (depth > 0) return sinkIn(above.text)
	}
	return undefined
}

/** A hit: what the line exposes, how to name it in a title, and where it goes. */
export interface PrivacyHit {
	readonly kind: PrivacyKind
	readonly subject: string
	readonly sink: Sink
}

const KIND_RANK = {
	secret: 0,
	government_id: 1,
	payment: 2,
	contact: 3,
	payload: 4,
	network: 5,
} as const satisfies Record<PrivacyKind, number>

/** What one added line hands to telemetry that it should not; at most one hit per line. */
export const privacyHitAt = (lines: ReadonlyArray<DiffLine>, index: number): PrivacyHit | undefined => {
	const line = lines[index]
	if (line === undefined || line.kind !== "add" || line.text.length > MAX_LINE_CHARS) return undefined
	if (isCommentLine(line.text) || TRANSFORMED_LINE.test(line.text)) return undefined
	const { literals, code, interpolations } = blankLiterals(line.text)
	const sink = sinkOf(lines, index)
	if (sink === undefined) return undefined
	for (const { kind, label, pattern } of VALUE_PATTERNS) {
		if (literals.some((literal) => pattern.test(literal.value))) return { kind, subject: label, sink }
	}
	if (literals.some((literal) => hasCardNumber(literal.value)))
		return { kind: "payment", subject: "a card number", sink }

	// Each comma-separated entry is judged on its own value: `{ email: user.email, ok: true }`.
	const segments = segmentsOf(code)
	// Keys and interpolations are blanked first: `set("k", v)` does not read its key as a constant,
	// and each `${...}` is judged on its own below.
	const blanked: ReadonlyArray<readonly [number, number]> = [
		...literals
			.filter((literal) => literal.key !== undefined)
			.map((literal) => [literal.offset, literal.offset + literal.value.length + 2] as const),
		...interpolations,
	]
	const values = blanked.reduce(
		(text, [start, end]) => text.slice(0, start) + " ".repeat(end - start) + text.slice(end),
		line.text,
	)
	const derived = segments.map(([start, end]) => DERIVED_VALUE.test(values.slice(start, end).trim()))
	const segmentAt = (offset: number) =>
		segments.findIndex(([start, end]) => offset >= start && offset <= end)
	const isDerived = (offset: number, valueFollows = false) => {
		const within = interpolations.find(([start, end]) => offset >= start && offset < end)
		if (within !== undefined) return DERIVED_VALUE.test(line.text.slice(within[0], within[1]).trim())
		const at = segmentAt(offset)
		return derived[at] === true || (valueFollows && derived[at + 1] === true)
	}

	const named: Array<{ readonly kind: PrivacyKind; readonly subject: string; readonly offset: number }> = []
	for (const literal of literals) {
		if (literal.key === undefined || !KEY_LITERAL.test(literal.value)) continue
		const kind = classifyName(literal.value)
		if (kind !== undefined && !isDerived(literal.offset, literal.key === "argument"))
			named.push({ kind, subject: `\`${literal.value}\``, offset: literal.offset })
	}
	for (const match of line.text.matchAll(BRACKET_ACCESS)) {
		const kind = classifyName(`${match[1]}.${match[2]}`, { chain: true })
		if (kind !== undefined && !isDerived(match.index ?? 0))
			named.push({ kind, subject: `\`${match[0]}\``, offset: match.index ?? 0 })
	}
	for (const { chain, offset } of chainsOf(code)) {
		const kind = classifyName(chain, { chain: true })
		if (kind !== undefined && !isDerived(offset)) named.push({ kind, subject: `\`${chain}\``, offset })
	}
	// A key naming a non-person owner (`vcs.repository.full_name`) speaks for its own entry, and for
	// the value entry after it in `set("k", v)`; never for other entries on the line.
	const ownerSegments = new Set(
		literals
			.filter(
				(literal) =>
					literal.key !== undefined &&
					wordsOf(literal.value).some((word) => NOT_A_PERSON.has(word)),
			)
			.flatMap((literal) => {
				const at = segmentAt(literal.offset)
				return literal.key === "argument" ? [at, at + 1] : [at]
			}),
	)
	const [worst] = named
		.filter((hit) => hit.kind !== "contact" || !ownerSegments.has(segmentAt(hit.offset)))
		.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])
	return worst === undefined ? undefined : { ...worst, sink }
}

const SEVERITY = {
	secret: "critical",
	government_id: "critical",
	payment: "critical",
	contact: "warn",
	payload: "warn",
	network: "info",
} as const satisfies Record<PrivacyKind, PrReviewSeverity>

const TITLE = {
	secret: "Credential",
	government_id: "Government id",
	payment: "Payment data",
	contact: "Personal data",
	payload: "Whole request payload",
	network: "Client IP address",
} as const satisfies Record<PrivacyKind, string>

const SINK_LABEL = {
	log: "a log",
	attribute: "a span attribute",
	event: "a span event",
} as const satisfies Record<Sink, string>

/** The scan's titles end in the sink, which is how a stored finding is known to be the scan's. */
const SCAN_TITLE = / written to a (?:log|span attribute|span event)$/

const WHY = {
	secret: "Anyone who can read the organization's telemetry can read it, for the whole retention window. Drop it, or record only whether it is set, and rotate any value already sent.",
	government_id:
		"Regulated identifiers must not leave the system of record, and telemetry is neither access-controlled nor erasable per person. Drop it and record an internal reference instead.",
	payment:
		"Card and bank data in telemetry puts the telemetry pipeline in scope for PCI DSS. Drop it; the last four digits or a payment id are enough to debug with.",
	contact:
		"Telemetry is retained and readable by the whole workspace, outside the user database's access controls, so a deletion request cannot reach it. Record a stable id such as `user.id`, or a hash if you need to correlate.",
	payload:
		"A whole body or header set carries whatever the caller sent, including credentials, cookies and personal data. Record the fields you need by name.",
	network:
		"An IP address is personal data under GDPR. Record it only where the retention policy covers it, or drop the last octet.",
} as const satisfies Record<PrivacyKind, string>

/** Source in a language with a telemetry SDK. */
const SCANNED_SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|cs|php|scala|exs?)$/i
/** Tooling and generated code: a script's output reaches a terminal, a migration's strings are SQL. */
const NOT_SCANNED = /(^|\/)(?:scripts?|bin|tools|generated|migrations)\//

/** Most scan findings one review files, so a sweeping refactor cannot bury the reviewer's own. */
const MAX_PRIVACY_FINDINGS = 10

const otherLines = (lines: ReadonlyArray<number>) =>
	lines.length === 0
		? ""
		: ` Also on ${lines.length === 1 ? "line" : "lines"} ${lines.slice(0, 5).join(", ")}${lines.length > 5 ? ` and ${lines.length - 5} more` : ""}.`

/** The diff's privacy findings: one per file and kind of data, on its first line, naming the others. */
export const privacyFindings = (files: ReadonlyArray<PullRequestFile>): ReadonlyArray<PrReviewFinding> =>
	files
		.filter(
			(file) =>
				file.patch !== null &&
				isRuntimeSource(file.path) &&
				SCANNED_SOURCE.test(file.path) &&
				!NOT_SCANNED.test(file.path),
		)
		.flatMap((file) => {
			const lines = parsePatch(file.patch)
			const byKind = new Map<PrivacyKind, { readonly hit: PrivacyHit; readonly lines: Array<number> }>()
			lines.forEach((line, index) => {
				const hit = privacyHitAt(lines, index)
				if (hit === undefined) return
				const seen = byKind.get(hit.kind)
				if (seen === undefined) byKind.set(hit.kind, { hit, lines: [line.newLine] })
				else seen.lines.push(line.newLine)
			})
			return [...byKind.values()].map(
				({ hit, lines: [first = 1, ...others] }) =>
					new PrReviewFinding({
						path: file.path,
						line: first,
						category: "security",
						checkId: "PII-01",
						severity: SEVERITY[hit.kind],
						title: `${TITLE[hit.kind]} ${hit.subject} written to ${SINK_LABEL[hit.sink]}`,
						body: `${WHY[hit.kind]}${otherLines(others)}`,
					}),
			)
		})
		.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
		.slice(0, MAX_PRIVACY_FINDINGS)

/** Whether a finding is one this scan filed, by its check id and the shape of its title. */
export const isPrivacyScanFinding = (finding: { readonly checkId?: string; readonly title: string }) =>
	finding.checkId === "PII-01" && SCAN_TITLE.test(finding.title)

/**
 * The scan's findings the reviewer did not file itself: a reviewer finding with a privacy check id
 * on the same lines says it in its own words, with the context the scan lacks.
 */
export const withoutReviewerOverlap = (
	scanned: ReadonlyArray<PrReviewFinding>,
	reviewer: ReadonlyArray<PrReviewFinding>,
): ReadonlyArray<PrReviewFinding> =>
	scanned.filter(
		(finding) =>
			!reviewer.some(
				(own) =>
					(own.checkId?.startsWith("PII-") ?? false) &&
					own.path === finding.path &&
					finding.line >= own.line &&
					finding.line <= (own.endLine ?? own.line),
			),
	)
