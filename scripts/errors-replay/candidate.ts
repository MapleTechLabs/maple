/**
 * A PROPOSED fingerprint (v3), replayed against real samples before it ships.
 *
 * Nothing in production reads this. It exists so a grouping change can be
 * measured (`bun run errors:replay`) instead of argued. When a proposal wins,
 * port it to `packages/domain/src/tinybird/fingerprint.ts` and the MV SQL, and
 * bump FINGERPRINT_VERSION.
 *
 * Each rule below targets a split seen in prod (2026-10-13 sample):
 *  1. Caller frames: one upstream 503 became one issue per query that hit it,
 *     because frames 2-3 are the callers. A namespaced error type already names
 *     the failure, so only the throw site is kept for those.
 *  2. Effect span frames (`(definition)`) vary the stack depth for one call path.
 *  3. Filesystem paths outside the home dir (`/tmp/...`, `/srv/...`) and the
 *     random suffixes inside them. Route paths (`/api/...`) are still kept.
 *  4. Prefixed and non-hex ids (`org_2Nn...`, `cus_...`, ULIDs) and UUIDs inside JSON.
 */
import { Option, Schema } from "effect"
import {
	applyRedactions,
	computeFingerprintInputs,
	FRAME_LINE_PATTERN,
	FRAME_REDACTIONS,
	MAX_FINGERPRINT_FRAMES,
	MSG_SCAN_CHARS,
	MSG_SIGNATURE_CHARS,
	MSG_TEXT_REDACTIONS,
	type Redactions,
} from "../../packages/domain/src/tinybird/fingerprint"

export interface ReplayEvent {
	readonly serviceName: string
	readonly exceptionType: string
	readonly statusMessage: string
	readonly exceptionStacktrace: string
}

const FRAME_LINE_RE = new RegExp(FRAME_LINE_PATTERN)

/** `@maple/http/errors/Foo`, `effect/ai/AiError`: a type that names one failure. */
const isNamespacedType = (type: string) => type.includes("/")

const isEffectSpanFrame = (line: string) => line.includes("(definition)")

const CANDIDATE_FRAME_REDACTIONS: Redactions = [
	// pnpm/bun store paths carry the package version; a dependency bump is not a new bug.
	["@[0-9]+\\.[0-9]+\\.[0-9]+[^/ )]*", "@#"],
	["\\(index [0-9]+\\)", "(index #)"],
	...FRAME_REDACTIONS,
]

const FS_ROOTS = "tmp|var|srv|private|opt|mnt|data|Volumes|System|app|work|run"

// Replacements may use `$1`; ClickHouse's replaceRegexpAll spells it `\1`. No
// lookbehind: these must port to RE2 for the MV.
const CANDIDATE_MSG_REDACTIONS: Redactions = [
	// ClickHouse errors echo the failing query; the error class is the bug, the
	// query text (an agent's own SQL, mostly) is a value.
	["(DB::Exception: [A-Za-z ]+?)[:.(][\\s\\S]*", "$1"],
	["^(\\[Error\\] [A-Za-z ]+?)[`'\"#:.(][\\s\\S]*", "$1"],
	// Filesystem paths, rooted where a route never is, and only at the start of a
	// token so `/api/data/x` is not read as `/data`. Runs before the home-dir pass.
	[`(^|[\\s'"(\`=])(~|/(${FS_ROOTS}|Users/[^/ ]+|home/[^/ ]+))(/[^ '"\`:,)]*)?`, "$1PATH"],
	// Prefixed ids: Clerk `org_`/`user_`, Stripe `cus_`/`sub_`, and their like.
	["\\b[a-z]{2,8}_[A-Za-z0-9]{10,}\\b", "ID"],
	// ULIDs: 26 Crockford base32 characters.
	["\\b[0-9A-HJKMNP-TV-Z]{26}\\b", "ID"],
	...MSG_TEXT_REDACTIONS,
]

const CANDIDATE_JSON_VALUE_REDACTIONS: Redactions = [["[0-9a-fA-F-]{6,}|[0-9]+", "#"]]

function candidateFrames(event: ReplayEvent): string {
	const keep = isNamespacedType(event.exceptionType) ? 1 : MAX_FINGERPRINT_FRAMES
	return event.exceptionStacktrace
		.split("\n")
		.filter((line) => FRAME_LINE_RE.test(line) && !isEffectSpanFrame(line))
		.slice(0, keep)
		.map((line) => applyRedactions(line, CANDIDATE_FRAME_REDACTIONS))
		.join("\n")
}

function candidateMessage(message: string): string {
	const json = parseJsonObject(message)
	if (json !== undefined) {
		return Object.keys(json)
			.map((key) => `${key}=${applyRedactions(JSON.stringify(json[key]), CANDIDATE_JSON_VALUE_REDACTIONS)}`)
			.sort()
			.join("|")
	}
	return applyWithGroups(message.slice(0, MSG_SCAN_CHARS), CANDIDATE_MSG_REDACTIONS).slice(0, MSG_SIGNATURE_CHARS)
}

const applyWithGroups = (value: string, redactions: Redactions): string =>
	redactions.reduce((acc, [pattern, replacement]) => acc.replace(new RegExp(pattern, "g"), replacement), value)

const decodeJsonObject = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const parseJsonObject = (text: string): Record<string, unknown> | undefined =>
	Option.getOrUndefined(decodeJsonObject(text))

/** The grouping key production computes today (the TS mirror of the MV). */
export function currentKey(event: ReplayEvent): string {
	const inputs = computeFingerprintInputs(event)
	return [event.serviceName, event.exceptionType, inputs.fpFrames, inputs.msgSignature].join("\u0000")
}

/** The proposed grouping key. */
export function candidateKey(event: ReplayEvent): string {
	return [event.serviceName, event.exceptionType, candidateFrames(event), candidateMessage(event.statusMessage)].join(
		"\u0000",
	)
}
