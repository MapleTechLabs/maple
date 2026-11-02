/**
 * Reference TS implementation of the error fingerprint normalization logic
 * that lives in the `error_events_mv` materialized view (materializations.ts).
 *
 * The SQL in ClickHouse is authoritative at runtime; this module exists so the
 * algorithm can be tested with representative stack traces from Node, Python,
 * Java, and Go without spinning up ClickHouse. If you change one, change both.
 *
 * The hash itself (cityHash64) is applied in ClickHouse and not reproduced here —
 * tests assert on the *inputs* to the hash, which is what actually determines
 * grouping quality.
 */

import { Option, Schema } from "effect"

export interface FingerprintInputs {
	/** First normalized frame — stored on error_events and error_issues for display. */
	readonly topFrame: string
	/** Top 3 normalized frames joined by newline — the stack portion of the hash. */
	readonly fpFrames: string
	/**
	 * Redacted StatusMessage signature, folded into the hash ALWAYS — not only
	 * when frames are absent. For a JSON object this is a general,
	 * key-name-agnostic canonical signature (sorted `key=redactedValue` pairs over
	 * ALL top-level keys); otherwise the redacted message prefix.
	 *
	 * Always-on because frames alone cannot separate two bugs in a bundled
	 * runtime: a Worker minifies every module into `worker.js`, so 25 distinct
	 * DatabaseError bugs shared one set of top frames and collapsed into a single
	 * issue. It cannot reinflate cardinality the way a raw prefix would, because
	 * everything variable is redacted before it reaches the hash.
	 */
	readonly msgSignature: string
	/**
	 * Value-aware human display label (mirrors the `ErrorLabel` column). Display
	 * only and decoupled from the fingerprint — many labels may map to one hash,
	 * so the key heuristic here never affects bucketing.
	 */
	readonly label: string
}

/**
 * Canonical pattern source for the fingerprint, shared by this module and by
 * the `error_events_mv` SQL in materializations.ts.
 *
 * Written as plain strings rather than regex literals because they have two
 * consumers with different syntax layers: `new RegExp()` here, and a ClickHouse
 * string literal there. The SQL used to carry a hand-copied duplicate of every
 * pattern below, which left the reference implementation and the thing
 * production actually runs free to drift — invisibly, because the tests only
 * ever exercise this file. `chRedactChain` renders the SQL from these same
 * constants, so a change here reaches both or neither.
 *
 * Everything must stay inside the RE2 subset ClickHouse supports: no
 * backreferences in a pattern, no lookaround. A replacement may name a capture
 * group as `$1`..`$9`, written the JS way; `chRedactChain` renders it as `\1`.
 * No other `$` and no backslash may appear in a replacement.
 */

/** Frames considered for the hash, from the top of the stack down. */
export const MAX_FINGERPRINT_FRAMES = 3
/**
 * Frames kept for a namespaced type (`@maple/http/errors/Foo`, `effect/ai/AiError`).
 * Such a type already names one failure, so frames 2-3 are only its callers: one
 * upstream 503 became one issue per query that happened to hit it.
 */
export const NAMESPACED_TYPE_MAX_FRAMES = 1
/** Marks an Effect span frame, which varies the stack depth of one call path. */
export const EFFECT_SPAN_FRAME_MARKER = "(definition)"
/**
 * How much of StatusMessage is scanned before redaction. Generous on purpose: the
 * cut runs before redaction, so a value it splits loses the closing quote that
 * redacts it, and where the cut falls moves with the lengths of the values before it.
 */
export const MSG_SCAN_CHARS = 1000
/** How much of the redacted result reaches the hash. */
export const MSG_SIGNATURE_CHARS = 120

/**
 * Matches frame lines by SHAPE — one alternative per runtime — rather than by
 * "contains a colon-digit". The old rule (`:\d+|line \d+`) accepted any line
 * with a colon-digit in it, which let two very common NON-frame lines through:
 * Drizzle's `params: <actual row values>` line, and the `Type: message` header
 * (`Code: 62`, `position 1628`, embedded timestamps). Row values and message
 * text then entered the hash, splitting a single bug into thousands of issues.
 *   V8/JVM:          `    at getUser (/app/users.ts:42:18)`
 *   Python:          `  File "/app/main.py", line 42, in get_user`
 *   Ruby:            `    from /app/user.rb:12:in 'find'`
 *   Firefox/Safari:  `getUser@https://app/assets/index.js:42:18`
 *                    (the name excludes `{`, `"` and `[`, so a compact JSON log line
 *                    holding an email and a number is not read as a frame)
 *                    An anonymous or indented one (`  @/app/x.js:4:2`, as printed
 *                    under a `[cause]`) needs a path or `scheme:/` right after `@`.
 *   Go/Rust:         `    /app/main.go:42 +0x1d`
 *   Apple:           `0   My App   0x104a2c1f0   +0x1d0f0`
 *
 * The Apple alternative has no source position to key on, because an iOS crash arrives
 * unsymbolicated — the app's symbols live in a dSYM that never leaves the build machine.
 * It keys on the shape instead: frame index, binary name, hex address. The offset is hex
 * (the SDK renders it that way deliberately) so `FRAME_REDACTIONS` erases it along with
 * the address, leaving `index binaryName +`. That is coarse — grouping by the sequence of
 * binaries rather than of functions — but it is *stable across releases*, which the raw
 * offsets are not: any code change shifts every offset below it and would re-split every
 * issue on every build. When dSYM symbolication lands, function names drop into the same
 * slot.
 *
 * The binary name is matched as `\\S.*`, not as one space-free token: a Mach-O image name
 * is the target's PRODUCT_NAME, and `My App` is an ordinary thing to call an app. Keying
 * on a single token silently excluded every such app from frame matching and left it
 * collapsed on the message hash — the exact failure this alternative exists to fix.
 */
export const FRAME_LINE_PATTERN =
	'^[ \\t]*at |^[ \\t]*File "|^[ \\t]+from [^ ]+:[0-9]+|^[^ \\t@{"\\[]+@[^ \\t]*:[0-9]+|^[ \\t]*[^ \\t@{"\\[]*@([a-z][a-z0-9+.-]*:)?/[^ \\t]*:[0-9]+|^[ \\t]+[^ \\t]+\\.(go|rs):[0-9]+|^[0-9]+ +\\S.* +0x[0-9a-fA-F]+'

/**
 * Python prints the OUTERMOST frame first, so its first frames are the framework and
 * instrumentation layers every request shares. A stack whose first frame is a Python
 * one is read from the bottom, where the raise site is.
 */
export const PYTHON_FRAME_PATTERN = '^[ \\t]*File "'

/** An ordered `[pattern, replacement]` list, applied outermost-first. */
export type Redactions = ReadonlyArray<readonly [pattern: string, replacement: string]>

/**
 * Volatile tokens stripped from a frame line, outermost first. Origin and
 * bundle hash come before the id/number pass: without them every preview host
 * splits an issue, and every deploy rotates Vite's 8-char content hash and
 * re-splits every browser and Worker issue that has already been triaged.
 */
export const FRAME_REDACTIONS: Redactions = [
	// pnpm/bun store paths and Go modules (`@v1.2.3`) carry the package version; a
	// dependency bump is not a new bug.
	["@v?[0-9]+\\.[0-9]+\\.[0-9]+[^/ )]*", "@#"],
	["\\(index [0-9]+\\)", "(index #)"],
	["file:///bundle/", ""],
	["https?://[^/ )]+", ""],
	// Where dependencies are installed differs per machine, image and hoisting layout
	// (`/app/node_modules`, `/app/apps/api/node_modules`, `/root/go/pkg/mod`); the code does not.
	[
		'(^|[ \\t("@])(file://)?([/.][^ \\t()"]*)?/(node_modules|site-packages|dist-packages|gems|pkg/mod)/',
		"$1$4/",
	],
	// A version directory (`gems/rails-8.1.4/`, `ruby/3.4.0/`, `effect/4.1.0/`) and a
	// Python minor (`python3.11/`): an upgrade is not a new bug.
	["([/-])v?[0-9]+\\.[0-9]+\\.[0-9]+[^/ )]*/", "$1#/"],
	["(/python)[0-9]+\\.[0-9]+/", "$1#/"],
	// A compiled Bun binary's virtual root differs per platform.
	["(/\\$bunfs|[A-Z]:/~BUN)/root/", ""],
	// JVM classes numbered or suffixed in the order a process happens to create them.
	["(\\$\\$Lambda|\\$Proxy|jdk\\.proxy|Generated[A-Za-z]*Accessor)\\$?[0-9]+", "$1"],
	["(\\$(HibernateProxy|ByteBuddy|MockitoMock))\\$[A-Za-z0-9]+", "$1"],
	["(-[A-Za-z0-9_-]{8})+\\.js", ".js"],
	["(-[A-Za-z0-9_-]{8})+\\.css", ".css"],
	["(/_astro/[^/ ).]+)\\.[A-Za-z0-9_-]{8}\\.js", "$1.js"],
	[":[0-9]+|line [0-9]+|0x[0-9a-fA-F]+|[0-9a-fA-F]{8,}|[0-9]{6,}", ""],
]

/**
 * Redaction for the plain-text branch, outermost first.
 *
 * The signature is folded into the hash for EVERY error, not just ones without
 * frames, so anything variable that survives this chain splits one bug into one
 * issue per value. The numeric passes alone were not enough: quoted identifiers
 * (`Table 'checkout_events' doesn't exist`) and query strings are pure runtime
 * values with no digit in them, and each distinct value minted its own issue.
 *
 * A quoted run is redacted only when it is unambiguously a VALUE: it contains a
 * path separator, or it is a single long token. Everything shorter is left
 * alone, because in error text a quoted short word is usually a schema
 * identifier and identifiers are bounded — `insert into "planetscale_events"`
 * and `insert into "anomaly_detector_states"` are two different bugs, and they
 * are exactly the discrimination the always-on signature exists to provide.
 * `reading 'id'` versus `reading 'name'` is the same argument.
 *
 * Both quote styles are treated alike. SQL convention says double quotes are
 * identifiers and single quotes are values, but the messages here are error
 * prose from many runtimes, not SQL, so the convention does not hold.
 *
 * The no-space rule inside each alternative is what keeps prose out: an
 * apostrophe in `doesn't` would otherwise pair with the next quote and swallow
 * the text between them.
 *
 * Route and file paths outside quotes are deliberately KEPT. `Transport error
 * (POST /api/query-engine/service-overview)` names the endpoint that failed,
 * and collapsing every path to a placeholder merges unrelated bugs into one
 * issue. Only the volatile parts of a path go: the origin (so preview hosts
 * don't split an issue), the home directory (so two users' local store paths
 * are one bug), and the query string (pure value).
 *
 * KNOWN RESIDUAL: a short entity slug still splits an issue, whether it is a
 * path segment (`/api/orgs/acme-corp/dashboards/latency-overview`) or a quoted
 * word. Nothing in the string distinguishes an org slug from a route name or a
 * table name, and every rule wide enough to catch `acme-corp` also catches
 * `service-overview` and `planetscale_events`. This is not recoverable with
 * another regex: it needs the emitting SDK to report the parameterized
 * `http.route` rather than the resolved URL. Fix it there.
 *
 * The id pass takes every digit run, not runs of 6+ — under the old threshold a
 * timestamp's two-digit hour survived and split one bug into one issue per hour
 * of the day.
 */
export const MSG_TEXT_REDACTIONS: Redactions = [
	["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}", "EMAIL"],
	['https?://[^/ )"]+', ""],
	["/(Users|home)/[^/ ]+", "/~"],
	['[?][A-Za-z0-9_]+=[^ )"]*', "?#"],
	["'[^' ]*/[^' ]*'|'[^' ]{25,}'", "'#'"],
	['"[^" ]*/[^" ]*"|"[^" ]{25,}"', '"#"'],
	["`[^` ]*/[^` ]*`|`[^` ]{25,}`", "`#`"],
	["[0-9a-fA-F-]{6,}|[0-9]+", "#"],
]

/**
 * Redaction for the JSON-object branch of the signature. Emails and URL origins go
 * first, as in the plain-text branch: `{"url":"https://<host>/"}` split per host.
 */
export const JSON_VALUE_REDACTIONS: Redactions = [
	...MSG_TEXT_REDACTIONS.slice(0, 2),
	["[0-9a-fA-F-]{6,}|[0-9]+", "#"],
]

/** A path segment, for the passes that read one: everything up to the next separator. */
const PATH_SEGMENT = `[^/? \\t\\r\\n'"\`:,)]`
/**
 * Long opaque tokens are wrapped in these, then unwrapped unless they mix case and
 * digits. RE2 has no lookahead, so "at least 20 characters AND contains a digit AND
 * both cases" is four passes, one condition each.
 */
const TOKEN_OPEN = "⟦"
const TOKEN_CLOSE = "⟧"

/** Words that put an HTTP status after them: `HTTP 404`, `statusCode: 503`, `status=429`. */
const STATUS_KEYWORDS = "HTTP|[Ss]tatus_?[Cc]ode|[Ss]tatus|returned|code|failed|failed with"
const HTTP_METHODS = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS"

const FS_ROOTS = "tmp|var|srv|private|opt|mnt|data|Volumes|System|app|work|run"
const PATH_DELIMS = ` \\t\\r\\n'"\`:,)`
const PATH_RULE = `(^|[ \\t\\r\\n'"(\`=])/(${FS_ROOTS}|Users/[^/${PATH_DELIMS}]+|home/[^/${PATH_DELIMS}]+)([/.][^${PATH_DELIMS}]*)?([${PATH_DELIMS}]|$)`

/**
 * The error-issue signature: `MSG_TEXT_REDACTIONS` wrapped in the v3 passes. Kept
 * apart from that list because the AI tool-error fingerprint and the web's
 * masked display share it, and v3 targets issue grouping alone.
 *
 * A filesystem path rooted where a route never is becomes `PATH`, matched only at
 * the start of a token so `/api/data/x` is not read as `/data`; it runs before the
 * home-dir pass. Prefixed ids (`org_...`, `cus_...`) and ULIDs become `ID`.
 *
 * The HTTP status pass tags a status with `§` before the number pass and untags it
 * after, which is how one entry of the replaced number pass keeps its digits.
 *
 * KNOWN RESIDUAL of the opaque-token pass: a PascalCase name of 20+ characters with a
 * digit (`S3BucketNotificationConfiguration`) reads as a token. Production showed none
 * in error text and thousands of random ids, so the trade is taken.
 */
export const ERROR_MSG_REDACTIONS: Redactions = [
	// Terminal colour codes: the same error printed to a TTY is the same error.
	["\\x1b\\[[0-9;]*m", ""],
	// A ClickHouse error echoes the failing query after its own text; cut only the
	// echo, so the identifier, function or type that names the bug stays.
	[
		"^((\\[Error\\]|[\\s\\S]*?DB::Exception:)[\\s\\S]*?)( [Ii]n scope | [Ww]hile processing )[\\s\\S]*",
		"$1",
	],
	// A route-not-found error names a path that by definition matched no route: a
	// scanner probing `/.env`, `/wp-login.php` and so on minted one issue per probe.
	// The path stops at any whitespace, so a cause on the next line still counts.
	["RouteNotFound \\(([A-Z]+) [^ \\t\\r\\n]*\\)", "RouteNotFound ($1 PATH)"],
	["\\bCannot (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) /[^ \\t\\r\\n]*", "Cannot $1 PATH"],
	[
		"\\bRoute (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS):/[^ \\t\\r\\n]* not found",
		"Route $1:PATH not found",
	],
	['No route found for "([A-Z]+) [^"\\r\\n]*"', 'No route found for "$1 PATH"'],
	[`(^|[ \\t\\r\\n'"(\`=])~/[^ '"\`:,)]*`, "$1PATH"],
	// The root must end at "/", "." or a delimiter, so `/datasets` is not `/data`.
	// Twice: a match consumes the delimiter the next adjacent path starts after.
	[PATH_RULE, "$1PATH$4"],
	[PATH_RULE, "$1PATH$4"],
	// The id part must hold a digit or capital, so `top_operations` stays a name.
	["\\b[a-z]{2,8}_[a-z]*[A-Z0-9][A-Za-z0-9]{8,}\\b", "ID"],
	["\\b[0-9A-HJKMNP-TV-Z]{26}\\b", "ID"],
	// An HTTP status names the failure: tag it so the number pass keeps it. A 4xx
	// keeps its code (401 and 404 are different bugs); every 5xx is one class, because
	// one outage answers 502, 520 and 524 in turn and must stay one issue.
	[`\\b(${STATUS_KEYWORDS})(:? ?|=)([1-4][0-9][0-9]|500)\\b`, "$1$2§$3"],
	[`\\b(${STATUS_KEYWORDS})(:? ?|=)5(0[1-9]|[1-9][0-9])\\b`, "$1$2§5xx"],
	// A status before a method is a response line: Effect's HttpClient reports
	// `StatusCode error (404 GET <url>)`, and without the tag 404 and 429 were one issue.
	[`(^|[^§0-9A-Za-z_.])([1-4][0-9][0-9]|500) (${HTTP_METHODS}) `, "$1§$2 $3 "],
	[`(^|[^§0-9A-Za-z_.])5(0[1-9]|[1-9][0-9]) (${HTTP_METHODS}) `, "$1§5xx $3 "],
	...MSG_TEXT_REDACTIONS.slice(0, 2),
	// After the origin pass, so a URL's path is reached: a segment holding `~`, `@`, `%`
	// or `$` is a value (a handle, an encoded string, a slug), never a route literal.
	[`/${PATH_SEGMENT}*[~@%$]${PATH_SEGMENT}*`, "/#"],
	...MSG_TEXT_REDACTIONS.slice(2, -1),
	// An unquoted opaque token (`rejected key tok_prod_9fQz2LmXc7RtV4bNw8Yh`) kept
	// every letter, one issue per key. A long token mixing both cases and a digit is a
	// value; a long snake_case or kebab-case name never mixes all three.
	["(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{20,})", `$1${TOKEN_OPEN}$2${TOKEN_CLOSE}`],
	[`${TOKEN_OPEN}([^${TOKEN_CLOSE}0-9]*)${TOKEN_CLOSE}`, "$1"],
	[`${TOKEN_OPEN}([^${TOKEN_CLOSE}A-Z]*)${TOKEN_CLOSE}`, "$1"],
	[`${TOKEN_OPEN}([^${TOKEN_CLOSE}a-z]*)${TOKEN_CLOSE}`, "$1"],
	[`${TOKEN_OPEN}[^${TOKEN_CLOSE}]*${TOKEN_CLOSE}`, "#"],
	// MSG_TEXT_REDACTIONS' own number pass, unchanged except that it keeps tagged statuses.
	["(§[1-4][0-9][0-9]|§500|§5xx)|[0-9a-fA-F-]{6,}|[0-9]+", "$1#"],
	["§([1-4][0-9][0-9]|500|5xx)#", "$1"],
]

/**
 * Escape a pattern or replacement for embedding in a ClickHouse single-quoted
 * string literal.
 */
export const chPattern = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

/**
 * Render a redaction list as the nested `replaceRegexpAll` chain ClickHouse
 * needs. The first entry ends up innermost, so the emitted SQL applies them in
 * the same order `applyRedactions` does.
 */
export const chRedactChain = (expr: string, redactions: Redactions): string =>
	redactions.reduce(
		(inner, [pattern, replacement]) =>
			`replaceRegexpAll(${inner}, ${chPattern(pattern)}, ${chPattern(replacement.replace(/\$([1-9])/g, "\\$1"))})`,
		expr,
	)

/**
 * Apply a redaction list in TypeScript. `$1`..`$9` expand to capture groups, as
 * `\1`..`\9` do in ClickHouse. The `u` flag makes `[^ ]{25,}` count code points,
 * as RE2 does over UTF-8, instead of UTF-16 units.
 */
export const applyRedactions = (value: string, redactions: Redactions): string =>
	redactions.reduce(
		(acc, [pattern, replacement]) => acc.replace(new RegExp(pattern, "gu"), replacement),
		value,
	)

/** The first `n` code points, as ClickHouse's `substringUTF8` / `leftUTF8` count them. */
const leftCodePoints = (value: string, n: number): string => Array.from(value).slice(0, n).join("")

/** 1-based code-point position of `needle`, 0 when absent, as `positionUTF8` returns. */
const positionCodePoints = (value: string, needle: string): number => {
	const index = value.indexOf(needle)
	return index === -1 ? 0 : Array.from(value.slice(0, index)).length + 1
}

const FRAME_LINE_RE = new RegExp(FRAME_LINE_PATTERN, "u")
/** `  at [2]["params"]`: a schema error's key path, not a stack frame. */
export const SCHEMA_PATH_LINE_PATTERN = "^[ \\t]*at \\["
const SCHEMA_PATH_LINE_RE = new RegExp(SCHEMA_PATH_LINE_PATTERN, "u")
/**
 * `    at http.client POST`: an Effect span frame with no location, no `(` and no
 * `:<digit>`. Its text is the span name, so a span rename (effect 4.0.4 made it
 * `at POST`) would otherwise rotate every fingerprint carrying it.
 */
export const SPAN_NAME_FRAME_PATTERN = "^[ \\t]*at ([^(:]|:[^0-9])*:?$"
const SPAN_NAME_FRAME_RE = new RegExp(SPAN_NAME_FRAME_PATTERN, "u")
const PYTHON_FRAME_RE = new RegExp(PYTHON_FRAME_PATTERN, "u")

/** Display-only candidate keys for the human label (NOT used by the fingerprint). */
export const JSON_LABEL_KEYS = ["title", "message", "error", "_tag", "reason", "name"] as const

/**
 * The SQL gate `isValidJSON(msg) AND JSONType(msg)='Object'`: RFC JSON, an object at
 * the top. ClickHouse is stricter than `JSON.parse` in three places the reader below
 * enforces: integers past 64 bits, floats past double range and lone surrogates.
 */
const decodeJsonObject = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

/** One top-level entry as `JSONExtractKeysAndValuesRaw` reports it, duplicates included. */
interface JsonEntry {
	readonly key: string
	/** The key re-escaped the way ClickHouse renders it inside a nested object. */
	readonly keyRaw: string
	/** The value re-serialized compactly, the way ClickHouse renders it. */
	readonly raw: string
	/** The decoded value when it is a string, which is all the label reads. */
	readonly text: string | undefined
}

type Read<A> = { readonly value: A; readonly end: number } | undefined

const matchAt = (pattern: RegExp, s: string, at: number): string | undefined => {
	const sticky = new RegExp(pattern.source, "y")
	sticky.lastIndex = at
	return sticky.exec(s)?.[0]
}
const skipSpace = (s: string, at: number) => at + (matchAt(/[ \t\n\r]*/, s, at)?.length ?? 0)

const JSON_STRING = /"(?:[^"\\]|\\.)*"/
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/
/** In `u` mode a paired surrogate reads as one astral code point, so only a lone one is `Cs`. */
const LONE_SURROGATE = /\p{Cs}/u
const INT64_MIN = -(2n ** 63n)
const UINT64_MAX = 2n ** 64n - 1n

const readString = (s: string, at: number): Read<{ readonly text: string; readonly raw: string }> => {
	const token = matchAt(JSON_STRING, s, at)
	const text = token === undefined ? undefined : Option.getOrUndefined(decodeJsonString(token))
	if (token === undefined || text === undefined || LONE_SURROGATE.test(text)) return undefined
	// ClickHouse escapes the two line separators JSON.stringify leaves raw, and writes
	// `\u000F` where JSON.stringify writes `\u000f`. An escaped backslash pairs first.
	const raw = JSON.stringify(text)
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029")
		.replace(/\\\\|\\u[0-9a-f]{4}/g, (escape) => escape.toUpperCase().replace("\\U", "\\u"))
	return { value: { text, raw }, end: at + token.length }
}

const readNumber = (s: string, at: number): Read<string> => {
	const token = matchAt(JSON_NUMBER, s, at)
	if (token === undefined) return undefined
	if (/^-?[0-9]+$/.test(token)) {
		const int = BigInt(token)
		return int < INT64_MIN || int > UINT64_MAX
			? undefined
			: { value: int.toString(), end: at + token.length }
	}
	const n = Number(token)
	if (!Number.isFinite(n)) return undefined
	const value = Object.is(n, -0) ? "-0" : JSON.stringify(n).replace("e+", "e")
	return { value, end: at + token.length }
}

/** Reads `{...}` or `[...]` at `at`, items separated by commas; `item` reads one. */
const readSequence = <A>(
	s: string,
	at: number,
	close: string,
	item: (s: string, at: number) => Read<A>,
): Read<ReadonlyArray<A>> => {
	const items: Array<A> = []
	let cursor = skipSpace(s, at + 1)
	if (s[cursor] === close) return { value: items, end: cursor + 1 }
	while (true) {
		const read = item(s, cursor)
		if (read === undefined) return undefined
		items.push(read.value)
		cursor = skipSpace(s, read.end)
		if (s[cursor] === close) return { value: items, end: cursor + 1 }
		if (s[cursor] !== ",") return undefined
		cursor = skipSpace(s, cursor + 1)
	}
}

const readEntry = (s: string, at: number): Read<JsonEntry> => {
	const key = readString(s, at)
	if (key === undefined) return undefined
	const colon = skipSpace(s, key.end)
	if (s[colon] !== ":") return undefined
	const value = readValue(s, skipSpace(s, colon + 1))
	if (value === undefined) return undefined
	return { value: { key: key.value.text, keyRaw: key.value.raw, ...value.value }, end: value.end }
}

function readValue(s: string, at: number): Read<{ readonly raw: string; readonly text: string | undefined }> {
	const head = s[at]
	if (head === "{") {
		const entries = readSequence(s, at, "}", readEntry)
		if (entries === undefined) return undefined
		const raw = `{${entries.value.map((e) => `${e.keyRaw}:${e.raw}`).join(",")}}`
		return { value: { raw, text: undefined }, end: entries.end }
	}
	if (head === "[") {
		const items = readSequence(s, at, "]", readValue)
		if (items === undefined) return undefined
		return {
			value: { raw: `[${items.value.map((v) => v.raw).join(",")}]`, text: undefined },
			end: items.end,
		}
	}
	if (head === '"') return readString(s, at)
	const literal = matchAt(/true|false|null/, s, at)
	if (literal !== undefined) return { value: { raw: literal, text: undefined }, end: at + literal.length }
	const number = readNumber(s, at)
	return number === undefined
		? undefined
		: { value: { raw: number.value, text: undefined }, end: number.end }
}

/** The top-level entries of a JSON-object message, or undefined where the SQL gate says no. */
function jsonObjectEntries(s: string): ReadonlyArray<JsonEntry> | undefined {
	if (Option.isNone(decodeJsonObject(s))) return undefined
	return readSequence(s, skipSpace(s, 0), "}", readEntry)?.value
}

/**
 * General, key-name-agnostic canonical signature: for every top-level key, emit
 * `key=redactedRawValue`, then sort and join. Mirrors the SQL
 * `arrayStringConcat(arraySort(arrayMap(... JSONExtractKeysAndValuesRaw ...)), '|')`.
 * Nested objects/arrays are hashed as their compact raw form; only top-level order
 * is canonicalized.
 */
function jsonSignature(entries: ReadonlyArray<JsonEntry>): string {
	return entries
		.map(({ key, raw }) => `${key}=${applyRedactions(raw, JSON_VALUE_REDACTIONS)}`)
		.sort(compareCodePoints)
		.join("|")
}

/**
 * `arraySort` orders strings by UTF-8 bytes, which is code-point order. JS `sort()`
 * compares UTF-16 units, and the two disagree once a key holds an astral character.
 */
const compareCodePoints = (a: string, b: string): number => {
	const left = Array.from(a, (ch) => ch.codePointAt(0) ?? 0)
	const right = Array.from(b, (ch) => ch.codePointAt(0) ?? 0)
	const at = left.findIndex((point, i) => point !== right[i])
	if (at === -1) return left.length - right.length
	return at >= right.length ? 1 : (left[at] ?? 0) - (right[at] ?? 0)
}

/** Mirrors the `_statusLabel` SQL multiIf (display-only). */
function statusLabel(statusMessage: string): string {
	if (statusMessage === "") return "Unknown Error"

	// Effect ParseError — not valid JSON; label by the first field. Must precede
	// the JSON branch (these start with "{" but aren't JSON objects).
	if (statusMessage.startsWith("{ readonly") || statusMessage.includes("└─")) {
		const m = statusMessage.match(/readonly (\w+)/)
		return m ? `Schema parse error: ${m[1]}` : "Schema parse error"
	}

	const entries = jsonObjectEntries(statusMessage)
	if (entries !== undefined || statusMessage.startsWith("[")) {
		// `JSONType` / `JSONExtractString` read the FIRST of duplicate keys.
		const text = (key: string) => entries?.find((e) => e.key === key)?.text ?? ""
		const label = JSON_LABEL_KEYS.map(text).find((v) => v !== "")
		if (label !== undefined) return label
		const type = text("type")
		if (type !== "") return /([^/]+)$/u.exec(type)?.[1] ?? ""
		return "JSON error"
	}

	// Legacy "ErrorClass: message" / "message (detail)" cut — first matching
	// delimiter (in this order), else first 150 characters. Mirrors the SQL multiIf,
	// which counts code points so a cut never splits a character.
	for (const delimiter of [": ", " (", "\n"]) {
		const position = positionCodePoints(statusMessage, delimiter)
		if (position > 3) return leftCodePoints(statusMessage, position - 1)
	}
	return leftCodePoints(statusMessage, 150)
}

/** Mirrors the nested `replaceRegexpAll` chain applied to each frame line. */
function normalizeFrame(line: string): string {
	return applyRedactions(line, FRAME_REDACTIONS)
}

/** Mirrors the `_msgSig` multiIf: JSON objects take the canonical key signature. */
function messageSignature(statusMessage: string): string {
	const entries = jsonObjectEntries(statusMessage)
	if (entries !== undefined) return jsonSignature(entries)
	return leftCodePoints(
		applyRedactions(leftCodePoints(statusMessage, MSG_SCAN_CHARS), ERROR_MSG_REDACTIONS),
		MSG_SIGNATURE_CHARS,
	)
}

/** `statusMessage` is the MV's resolved `_msgText`, including attribute fallback. */
export function computeFingerprintInputs(args: {
	readonly exceptionType: string
	readonly exceptionStacktrace: string
	readonly statusMessage: string
}): FingerprintInputs {
	const msgSignature = messageSignature(args.statusMessage)
	// A namespaced type plus its message names the failure, so the throw site is enough.
	// With no message the frames are the only identity left; keep all three.
	const maxFrames =
		args.exceptionType.includes("/") && msgSignature !== ""
			? NAMESPACED_TYPE_MAX_FRAMES
			: MAX_FINGERPRINT_FRAMES
	const frameLines = args.exceptionStacktrace
		.split("\n")
		.filter(
			(line) =>
				FRAME_LINE_RE.test(line) &&
				!line.includes(EFFECT_SPAN_FRAME_MARKER) &&
				!SCHEMA_PATH_LINE_RE.test(line) &&
				!SPAN_NAME_FRAME_RE.test(line),
		)
	const rawFrames = (
		PYTHON_FRAME_RE.test(frameLines[0] ?? "") ? [...frameLines].reverse() : frameLines
	).slice(0, maxFrames)

	const topFrames = rawFrames.map(normalizeFrame)
	const topFrame = topFrames[0] ?? ""
	const fpFrames = topFrames.join("\n")

	const label = args.exceptionType !== "" ? args.exceptionType : statusLabel(args.statusMessage)

	return { topFrame, fpFrames, msgSignature, label }
}

/**
 * Version of the fingerprint algorithm above.
 *
 * Bumped whenever a change to frame matching, normalization, or the message
 * signature rotates hashes for errors that are still occurring. The evaluator
 * stamps it on every issue it writes, and retention archives issues carrying an
 * older version: after a bump the live bugs each get one clean issue and the
 * stale rows retire deterministically, instead of sitting in `triage` until the
 * 14-day auto-resolve window catches up.
 *
 * That archive assumes a bump rotates EVERY hash, so since v3 the version itself
 * is hashed, as `FINGERPRINT_HASH_SALT`. Where an old hash is still produced
 * anyway (a self-hosted warehouse that has not applied the new view, or a deploy
 * gap), the tick restores an archived open issue on its next occurrence and
 * restamps its version. (The Apple frame alternative and the attribute fallback
 * predate both and skipped a bump for that reason. Dropping location-less span
 * frames also skipped one: it re-keys only the stacks carrying such a line, and so
 * did folding route-not-found paths, URL path values and opaque tokens, the 1000
 * character scan, keeping compact JSON log lines out of the frames, keeping the
 * status of `statusCode: N` and `(N GET url)`, and stripping origins and emails
 * from JSON values.)
 *
 * Deliberately NOT a ClickHouse column. Old and new hashes cannot collide, so
 * the warehouse needs no discriminator — only the Postgres row does.
 *
 * Changing the view does NOT rewrite history: rows already in `error_events`
 * keep their old hashes for the rest of their 90-day TTL, so a new issue's
 * detail view, occurrence sparkline and sample traces all start empty and fill
 * from cutover forward. That is expected, not a regression.
 *
 * v1 → v2: frame lines are matched by shape rather than by "contains a
 * colon-digit", and the message signature is always folded in and additionally
 * strips quoted values and query strings.
 *
 * v2 → v3: a namespaced type keeps only its throw site, Effect span frames are
 * dropped, frames lose package versions and `(index N)`, the message signature
 * cuts ClickHouse query echoes and redacts filesystem paths, prefixed ids and
 * ULIDs, JSON values lose UUIDs, and the version salt enters the hash.
 */
export const FINGERPRINT_VERSION = 3

/** Hashed into `FingerprintHash` so a version bump rotates every issue. */
export const FINGERPRINT_HASH_SALT = `fp${FINGERPRINT_VERSION}`
