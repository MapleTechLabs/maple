// How a failed command reads on stderr. Every failure becomes `error: <one
// line>` plus an optional `hint:` line; causes, stacks, and SQL stay behind
// `--debug`. Pure so the rules are testable (bin.ts runs at import time).

import { Predicate } from "effect"

export interface FailureReport {
	/** The failure's `_tag`, recorded as `maple.cli.outcome` on the root span. */
	readonly tag: string
	readonly message: string
	readonly hint?: string
	/**
	 * True for outcomes that are the CLI working correctly (bad input, nothing
	 * running, not found). These leave the root span `Ok`.
	 */
	readonly expected: boolean
}

const READ_ONLY_PREFIX = "read-only query endpoint: "
const DEBUG_HINT = "rerun with --debug to see the query and the full error"

/** A link in a failure's cause chain that names itself with a string `_tag`. */
export interface TaggedLink {
	readonly _tag: string
}

const isTaggedLink = (u: unknown): u is TaggedLink =>
	Predicate.hasProperty(u, "_tag") && typeof u._tag === "string"

const tagOf = (u: unknown): string | undefined => (isTaggedLink(u) ? u._tag : undefined)

const field = <A>(u: unknown, key: string, refine: Predicate.Refinement<unknown, A>): A | undefined => {
	if (!Predicate.hasProperty(u, key)) return undefined
	const value = u[key]
	return refine(value) ? value : undefined
}

const stringField = (u: unknown, key: string): string | undefined => field(u, key, Predicate.isString)

const numberField = (u: unknown, key: string): number | undefined => field(u, key, Predicate.isNumber)

/** The error and every `cause` below it, bounded against cycles. */
export const causeChain = (error: unknown): ReadonlyArray<unknown> => {
	const chain: Array<unknown> = []
	let current: unknown = error
	while (current !== undefined && current !== null && chain.length < 10 && !chain.includes(current)) {
		chain.push(current)
		current = Predicate.hasProperty(current, "cause") ? current.cause : undefined
	}
	return chain
}

export const findInChain = (error: unknown, tag: string): TaggedLink | undefined =>
	causeChain(error)
		.filter(isTaggedLink)
		.find((link) => link._tag === tag)

/** The reason `/local/query` gave for refusing a write, if that is what failed. */
export const readOnlyRejection = (error: unknown): string | undefined => {
	const failed = findInChain(error, "@maple/query-engine/LocalQueryFailed")
	// chDB's own readonly guard, which catches what the endpoint's parser lets through.
	if (stringField(failed, "type") === "READONLY") return "writes and table functions are not allowed"
	const detail = stringField(failed, "detail")
	if (numberField(failed, "status") !== 400 || detail === undefined) return undefined
	return detail.startsWith(READ_ONLY_PREFIX) ? detail.slice(READ_ONLY_PREFIX.length).trim() : undefined
}

/** The local binary never answered (connection refused, socket dropped). */
export const isLocalUnreachable = (error: unknown): boolean =>
	findInChain(error, "@maple/query-engine/LocalQueryUnreachable") !== undefined

// Statuses a Maple server never gives `POST /local/query`, but other HTTP servers do.
const NOT_MAPLE_STATUSES: ReadonlySet<number | undefined> = new Set([404, 405, 501])

/** Something answered at the local URL, but it has no `/local/query` route. */
export const isNotMapleServer = (error: unknown): boolean =>
	NOT_MAPLE_STATUSES.has(numberField(findInChain(error, "@maple/query-engine/LocalQueryFailed"), "status"))

/** First line only: warehouse messages can carry a multi-line ClickHouse trace. */
const firstLine = (message: string): string => {
	const line = message.split("\n").find((l) => l.trim() !== "") ?? message
	return line.trim()
}

/**
 * chDB's text without the transport wrapping and the parser's list of every
 * token it would have accepted: `Syntax error: failed at position 7 ... (SYNTAX_ERROR)`.
 */
export const cleanQueryMessage = (message: string): string =>
	firstLine(message)
		.replace(/^Local query failed \(\d+\):\s*/, "")
		.replace(/^query failed:\s*/, "")
		.replace(/^Code:\s*\d+\.\s*DB::Exception:\s*/, "")
		.replace(/\.\s*Expected one of:.*?(\([A-Z][A-Z0-9_]+\))?$/, ". $1")
		.trim()

/**
 * The human sentence in a failure. v2 API errors arrive as an `{ error: {...} }`
 * envelope, or with the envelope as `message`, so look one level down too.
 */
export const messageOf = (u: unknown): string => {
	const candidates = [
		u,
		Predicate.hasProperty(u, "message") ? u.message : undefined,
		Predicate.hasProperty(u, "error") ? u.error : undefined,
	]
	for (const candidate of candidates) {
		const message = stringField(candidate, "message")
		if (message !== undefined && message !== "") return message
	}
	return typeof u === "string" ? u : String(u)
}

/** A v2 401/403: the stored credential is missing, expired, or revoked. */
const isAuthRejection = (error: unknown): boolean =>
	causeChain(error).some((link) => {
		const inner = Predicate.hasProperty(link, "error") ? link.error : undefined
		return [link, inner].some(
			(u) =>
				/Unauthorized|Forbidden/.test(tagOf(u) ?? "") ||
				stringField(u, "code") === "invalid_credentials",
		)
	})

// Tags whose `message` is already the whole user-facing story.
const EXPECTED_TAGS = new Set([
	"@maple/cli/ModeError",
	"@maple/cli/TimeRangeError",
	"@maple/cli/UsageError",
	"@maple/cli/NotFoundError",
	"@maple/cli/LocalServerUnreachableError",
	"@maple/cli/ReadOnlyQueryError",
	"@maple/cli/ServerStateError",
	"@maple/cli/CheckpointPreconditionError",
])

const TIME_RANGE_HINT =
	"use --since 30m, 6h or 7d, or --start/--end as 'YYYY-MM-DD HH:mm:ss' (UTC) or ISO-8601"

export const describeFailure = (error: unknown): FailureReport => {
	const tag = tagOf(error) ?? "UnknownError"

	// Mode failures can arrive wrapped in the warehouse executor's error type.
	const mode = findInChain(error, "@maple/cli/ModeError")
	if (mode !== undefined) {
		const hint = stringField(mode, "hint")
		return {
			tag: "@maple/cli/ModeError",
			message: messageOf(mode),
			...(hint === undefined ? undefined : { hint }),
			expected: true,
		}
	}

	if (EXPECTED_TAGS.has(tag)) {
		const hint =
			stringField(error, "hint") ?? (tag === "@maple/cli/TimeRangeError" ? TIME_RANGE_HINT : undefined)
		return {
			tag,
			message: messageOf(error),
			...(hint === undefined ? undefined : { hint }),
			expected: true,
		}
	}

	if (tag.startsWith("@maple/http/errors/Warehouse")) {
		if (isAuthRejection(error)) {
			return {
				tag,
				message: `the workspace rejected the stored credentials (${messageOf(error)})`,
				hint: "run `maple login` again, or pass --local to query a local server",
				expected: true,
			}
		}
		const reason = readOnlyRejection(error)
		if (reason !== undefined) {
			return {
				tag: "@maple/cli/ReadOnlyQueryError",
				message: `maple query is read-only: ${reason}`,
				expected: true,
			}
		}
		if (isLocalUnreachable(error)) {
			return {
				tag,
				message: "could not reach the local Maple server",
				hint: "start it with `maple start`, or point MAPLE_LOCAL_URL at the running server",
				expected: true,
			}
		}
		// A `WarehouseClientError` without a cause is the CLI's own refusal (for
		// example a command v2 cannot answer in remote mode), not a query failure.
		const refusal =
			tag === "@maple/http/errors/WarehouseClientError" &&
			!(Predicate.hasProperty(error, "cause") && error.cause !== undefined)
		return {
			tag,
			message: cleanQueryMessage(messageOf(error)),
			...(refusal ? undefined : { hint: DEBUG_HINT }),
			expected: refusal,
		}
	}

	if (tagOf(error) !== undefined) {
		return { tag, message: firstLine(messageOf(error)), expected: false }
	}
	// Not a tagged failure: a defect or a thrown value.
	return {
		tag,
		message: `unexpected failure: ${firstLine(messageOf(error))}`,
		hint: "rerun with --debug for the stack trace",
		expected: false,
	}
}

/** `error: …` plus an optional `hint: …`, newline-terminated, for stderr. */
export const formatFailure = (report: Pick<FailureReport, "message" | "hint">): string =>
	`error: ${report.message}\n${report.hint === undefined ? "" : `hint: ${report.hint}\n`}`
