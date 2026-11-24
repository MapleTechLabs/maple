import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"

/** Span event attribute carrying `{ "<frame url>": "<debug id>" }` as a JSON string. */
export const DEBUG_IDS_ATTRIBUTE = "maple.exception.debug_ids"

/** One stack frame as written in the stack trace, before any source map. */
export interface ParsedFrame {
	readonly raw: string
	readonly function: string | null
	readonly url: string | null
	readonly line: number | null
	readonly column: number | null
}

export interface ParsedJsStack {
	/** The `TypeError: msg` header line, when the stack starts with one. */
	readonly message: string | null
	/** Top of stack first. */
	readonly frames: ReadonlyArray<ParsedFrame>
}

export const StackFrameContext = Schema.Struct({
	pre: Schema.Array(Schema.String),
	line: Schema.String,
	post: Schema.Array(Schema.String),
})
export type StackFrameContext = typeof StackFrameContext.Type

export const StackFrame = Schema.Struct({
	raw: Schema.String,
	function: Schema.NullOr(Schema.String),
	/** True when a source map supplied `function`; otherwise it is the name as the stack wrote it. */
	function_from_map: Schema.optionalKey(Schema.Boolean),
	file: Schema.NullOr(Schema.String),
	line: Schema.NullOr(Schema.Number),
	column: Schema.NullOr(Schema.Number),
	in_app: Schema.Boolean,
	resolved: Schema.Boolean,
	context: Schema.NullOr(StackFrameContext),
})
export type StackFrame = typeof StackFrame.Type

export const SymbolicationStatus = Schema.Literals(["resolved", "partial", "missing_map", "not_applicable"])
export type SymbolicationStatus = typeof SymbolicationStatus.Type

export const SymbolicatedStack = Schema.Struct({
	status: SymbolicationStatus,
	frames: Schema.Array(StackFrame),
	missing: Schema.Array(Schema.String),
})
export type SymbolicatedStack = typeof SymbolicatedStack.Type

/**
 * Stack text is customer data, so lines are parsed with index splits and tail checks, never one
 * backtracking pattern, and overlong lines are not frames at all.
 */
const MAX_FRAME_LINE = 2000
const DIGITS = /^\d+$/u
const GECKO_EVAL_TAIL = /^ line (\d+) > (?:eval|Function)(?::\d+:\d+)?$/u
const PROMISE_INDEX = /^index \d+$/u
const NO_LOCATION = new Set(["native", "<anonymous>", "[native code]", "unknown location"])

interface Location {
	readonly url: string | null
	readonly line: number | null
	readonly column: number | null
}

const NOWHERE: Location = { url: null, line: null, column: null }

/** The text before and after the first (or last) `separator`, when it occurs. */
const splitAt = (text: string, separator: string, last = false) =>
	Option.map((last ? Str.lastIndexOf(separator) : Str.indexOf(separator))(text), (index) => ({
		before: Str.slice(0, index)(text),
		after: Str.slice(index + separator.length)(text),
	}))

/** `url:line:column` or `url:line`, split at the last colons; the url must not be empty. */
const parseUrlLocation = (location: string): Option.Option<Location> =>
	Option.flatMap(
		Option.filter(
			splitAt(location, ":", true),
			({ before, after }) => before !== "" && DIGITS.test(after),
		),
		({ before, after }) =>
			Option.match(
				Option.filter(
					splitAt(before, ":", true),
					(inner) => inner.before !== "" && DIGITS.test(inner.after),
				),
				{
					onNone: (): Option.Option<Location> =>
						Option.some({ url: before, line: Number(after), column: null }),
					onSome: (inner): Option.Option<Location> =>
						Option.some({ url: inner.before, line: Number(inner.after), column: Number(after) }),
				},
			),
	)

/** `eval at fn (url:1:2), <anonymous>:3:4`: the eval call site, else no location. */
const parseEvalOrigin = (location: string): Location => {
	// The innermost origin: nested evals read `eval at a (eval at b (url:1:2)), ...`, so the text
	// between the first `)` and the last `(` before it is the concrete call site.
	const origin = Option.flatMap(splitAt(location, ")"), ({ before }) =>
		Option.map(splitAt(before, "(", true), ({ after }) => after),
	)
	const located = Option.flatMap(
		Option.filter(origin, (text) => !/\s/u.test(text)),
		parseUrlLocation,
	)
	return Option.isSome(located) && located.value.column !== null ? located.value : NOWHERE
}

const parseLocation = (location: string): Option.Option<Location> => {
	const trimmed = Str.trim(location)
	if (NO_LOCATION.has(trimmed)) return Option.some(NOWHERE)
	// `at async Promise.all (index 0)`: a combinator between two app frames, kept so the frame
	// below it is not taken for the direct caller of the one above.
	if (PROMISE_INDEX.test(trimmed)) return Option.some(NOWHERE)
	if (Str.startsWith("eval at ")(trimmed)) return Option.some(parseEvalOrigin(trimmed))
	// Firefox eval frames: `url line 3 > eval:1:1`.
	const geckoEval = Option.flatMap(
		Option.filter(splitAt(trimmed, " line "), ({ before }) => before !== ""),
		({ before, after }) =>
			Option.map(Option.fromNullishOr(GECKO_EVAL_TAIL.exec(` line ${after}`)?.[1]), (line) => ({
				url: before,
				line: Number(line),
				column: null,
			})),
	)
	return Option.isSome(geckoEval) ? geckoEval : parseUrlLocation(trimmed)
}

const nonEmpty = (value: string | undefined): string | null => {
	const trimmed = Str.trim(value ?? "")
	return trimmed === "" ? null : trimmed
}

const frameOf = (raw: string, fn: string | null, location: Location): ParsedFrame => ({
	raw: Str.trim(raw),
	function: fn,
	url: location.url,
	line: location.line,
	column: location.column,
})

/** `rest` without a leading `word ` and the whitespace after it. */
const dropWord = (rest: string, word: string): string =>
	Str.startsWith(`${word} `)(rest) || Str.startsWith(`${word}\t`)(rest)
		? Str.trimStart(Str.slice(word.length)(rest))
		: rest

/** A V8 frame after its `at `: `fn (location)`, or a bare location. */
const parseV8Frame = (raw: string, rest: string): Option.Option<ParsedFrame> => {
	const body = dropWord(dropWord(rest, "async"), "new")
	// The function ends at the first ` (`; the location runs to the final `)`.
	const call = Option.filter(splitAt(body, " ("), () => Str.endsWith(")")(body))
	if (Option.isSome(call)) {
		return Option.map(parseLocation(Str.slice(0, -1)(call.value.after)), (location) =>
			frameOf(raw, nonEmpty(call.value.before), location),
		)
	}
	// `at spanName` alone is an Effect span, not a code location.
	return Option.flatMap(parseLocation(body), (loc) =>
		loc.url === null && !NO_LOCATION.has(Str.trim(body))
			? Option.none()
			: Option.some(frameOf(raw, null, loc)),
	)
}

/** A frame from one stack line; none for headers, `caused by` lines and Effect span lines with no location. */
export const parseJsFrame = (raw: string): Option.Option<ParsedFrame> => {
	if (raw.length > MAX_FRAME_LINE) return Option.none()
	const line = Str.trim(raw)
	if (Str.startsWith("at ")(line) || Str.startsWith("at\t")(line)) {
		const rest = Str.trim(Str.slice(3)(line))
		return rest === "" ? Option.none() : parseV8Frame(raw, rest)
	}
	// Firefox and Safari: `fn@location`, the function never holding an `@`.
	return Option.flatMap(
		Option.filter(splitAt(line, "@"), ({ after }) => Str.trim(after) !== ""),
		({ before, after }) => Option.map(parseLocation(after), (loc) => frameOf(raw, nonEmpty(before), loc)),
	)
}

/** Parses V8, Firefox and Safari stack traces, top of stack first. */
export const parseJsStack = (stacktrace: string): ParsedJsStack => {
	const lines = Arr.filter(Str.split(stacktrace, /\r?\n/u), (line) => Str.trim(line) !== "")
	const frames = Arr.getSomes(Arr.map(lines, parseJsFrame))
	const first = Arr.head(lines)
	const message = Option.match(first, {
		onNone: () => null,
		onSome: (line) => (Option.isSome(parseJsFrame(line)) ? null : Str.trim(line)),
	})
	return { message, frames }
}

const DebugIdsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
const decodeDebugIdsJson = Schema.decodeUnknownOption(DebugIdsJson)

/** Decodes the `maple.exception.debug_ids` attribute; anything malformed is an empty map. */
export const decodeDebugIds = (attr: string | undefined): ReadonlyMap<string, string> =>
	attr === undefined
		? new Map()
		: Option.match(decodeDebugIdsJson(attr), {
				onNone: () => new Map(),
				onSome: (record) => new Map(Rec.toEntries(record)),
			})

const SCHEME_AND_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/u
const decodeUriPart = Option.liftThrowable(decodeURIComponent)

const stripLeadingSlashes = Str.replace(/^(?:\.\/|\/)+/u, "")

/**
 * The path part of a frame URL or file path, percent-decoded (raw when it does not decode):
 * no scheme, host, query, hash or leading `/` and `./`.
 */
export const frameUrlPath = (url: string): string => {
	const noQuery = Str.replace(/[?#].*$/u, "")(Str.trim(url))
	const path = Str.replace(SCHEME_AND_AUTHORITY, "")(noQuery)
	return stripLeadingSlashes(Option.getOrElse(decodeUriPart(path), () => path))
}

/** True when the frame URL's path is the stored minified path or ends with it at a `/` boundary. */
export const urlMatchesMinifiedPath = (url: string, minifiedPath: string): boolean => {
	// The stored path is already normalized at upload; a `#` or `?` in it is part of the file name.
	const target = stripLeadingSlashes(Str.trim(minifiedPath))
	if (target === "") return false
	const path = frameUrlPath(url)
	return path === target || Str.endsWith(`/${target}`)(path)
}

/** A frame URL a source map can belong to: a JavaScript file or a served URL. */
export const isSourceMappableUrl = (url: string): boolean => {
	const path = Str.toLowerCase(Str.replace(/[?#].*$/u, "")(url))
	return /\.(?:m|c)?js$/u.test(path) || /^https?:\/\//u.test(path)
}

const NOT_IN_APP_FRAGMENTS = [
	"node_modules/",
	"webpack/runtime",
	"webpack/bootstrap",
	"chrome-extension://",
	"moz-extension://",
	"safari-extension://",
	"<anonymous>",
]

/** False for dependency, bundler runtime, browser extension and engine-internal frames. */
export const isInAppPath = (path: string): boolean => {
	const normalized = Str.replace(/\\/gu, "/")(Str.trim(path))
	if (normalized === "native" || normalized === "[native code]") return false
	if (Str.startsWith("node:")(normalized)) return false
	return !Arr.some(NOT_IN_APP_FRAGMENTS, (fragment) => Str.includes(fragment)(normalized))
}
