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

const V8_WITH_LOCATION = /^\s*at\s+(?:async\s+)?(?:new\s+)?(.*?)\s+\((.*)\)\s*$/u
const V8_BARE = /^\s*at\s+(?:async\s+)?(.+?)\s*$/u
const GECKO = /^\s*([^@]*)@(.+?)\s*$/u
const LOCATION = /^(.*?):(\d+)(?::(\d+))?$/u
const GECKO_EVAL = /^(.*?) line (\d+) > (?:eval|Function)(?::\d+:\d+)?$/u
const EVAL_ORIGIN = /\((\S+?:\d+:\d+)\)/u
const NO_LOCATION = new Set(["native", "<anonymous>", "[native code]", "unknown location"])

interface Location {
	readonly url: string | null
	readonly line: number | null
	readonly column: number | null
}

const parseLocation = (location: string): Option.Option<Location> => {
	const trimmed = Str.trim(location)
	if (NO_LOCATION.has(trimmed)) return Option.some({ url: null, line: null, column: null })
	// V8 eval frames point at the eval call site: `eval at fn (url:1:2), <anonymous>:3:4`.
	if (Str.startsWith("eval at ")(trimmed)) {
		const origin = EVAL_ORIGIN.exec(trimmed)?.[1]
		return origin === undefined
			? Option.some({ url: null, line: null, column: null })
			: parseLocation(origin)
	}
	const geckoEval = GECKO_EVAL.exec(trimmed)
	if (geckoEval !== null) {
		return Option.some({ url: geckoEval[1] ?? null, line: Number(geckoEval[2]), column: null })
	}
	const match = LOCATION.exec(trimmed)
	if (match === null || match[1] === undefined || match[1] === "") return Option.none()
	return Option.some({
		url: match[1],
		line: Number(match[2]),
		column: match[3] === undefined ? null : Number(match[3]),
	})
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

/** A frame from one stack line; none for headers, `caused by` lines and Effect span lines with no location. */
export const parseJsFrame = (raw: string): Option.Option<ParsedFrame> => {
	const withLocation = V8_WITH_LOCATION.exec(raw)
	if (withLocation !== null) {
		return Option.map(parseLocation(withLocation[2] ?? ""), (location) =>
			frameOf(raw, nonEmpty(withLocation[1]), location),
		)
	}
	const bare = V8_BARE.exec(raw)
	if (bare !== null) {
		const location = parseLocation(bare[1] ?? "")
		// `at spanName` alone is an Effect span, not a code location.
		return Option.flatMap(location, (loc) =>
			loc.url === null && !NO_LOCATION.has(Str.trim(bare[1] ?? ""))
				? Option.none()
				: Option.some(frameOf(raw, null, loc)),
		)
	}
	const gecko = GECKO.exec(raw)
	if (gecko !== null) {
		return Option.map(parseLocation(gecko[2] ?? ""), (location) =>
			frameOf(raw, nonEmpty(gecko[1]), location),
		)
	}
	return Option.none()
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
