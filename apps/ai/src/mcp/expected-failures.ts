import { Effect, Predicate, Record as Rec, String as Str } from "effect"

/**
 * MCP failures that are expected 4xx client outcomes, not bugs: a bad or absent
 * credential, or a tool call whose parameters do not decode. Per CLAUDE.md only
 * 5xx is an `Error` span, so these must leave the span status Ok — with the
 * outcome recorded as attributes and a Warn log — instead of an exception event.
 *
 * The mechanism is the same one `@maple/domain/anticipated-errors` drives for
 * HTTP: the SDK's tracer exports a span whose failure is caused *entirely* by an
 * anticipated identifier as OTLP `Ok` with no `exception` event. That set is
 * derived by reflection over the domain HTTP exports and cannot see these
 * classes (they live in `apps/ai/src/mcp`), so they are listed here and spread
 * into the runtime telemetry configs alongside it.
 *
 * `McpAuthUnavailableError` (503) and `McpQueryError` are deliberately absent:
 * they are real failures and keep their Error spans.
 */
const MCP_EXPECTED_FAILURE_STATUS = {
	"@maple/mcp/errors/McpDecodeError": 400,
	"@maple/mcp/errors/McpAuthMissingError": 401,
	"@maple/mcp/errors/McpAuthInvalidError": 401,
	// The call was well-formed JSON but the tool will not do what it asks.
	"@maple/mcp/errors/McpInvalidInputError": 400,
	// A dependency still warming up: the same call works later.
	"@maple/mcp/errors/McpNotReadyError": 409,
	// A capability the org or deployment has not set up.
	"@maple/mcp/errors/McpUnavailableError": 412,
	// The query hit a warehouse budget; mirrors `WarehouseQuotaExceededError`'s 429.
	"@maple/mcp/errors/McpQueryBudgetError": 429,
} satisfies Record<string, number>

// Keyed by a plain string so a `_tag` off any failure can be looked up without
// narrowing it into the literal union first.
const expectedStatusByTag = new Map<string, number>(Rec.toEntries(MCP_EXPECTED_FAILURE_STATUS))

/** Spread into `anticipatedErrorIdentifiers` next to `ANTICIPATED_ERROR_IDENTIFIERS`. */
export const MCP_ANTICIPATED_ERROR_IDENTIFIERS: ReadonlyArray<string> = [...expectedStatusByTag.keys()]

/** JSON-RPC codes for a request the client got wrong: an unknown method, or params (a tool name) that name nothing. */
const CLIENT_PROTOCOL_CODES: ReadonlySet<unknown> = new Set([-32601, -32602])

/** Why a repository command never started, when the reason is the call's ref, repository or path. */
const CALLER_SPAWN_CAUSES: ReadonlySet<string | undefined> = new Set([
	"SandboxRunCheckoutPending",
	"@maple/backend/vcs/VcsSourceRefNotFoundError",
	"@maple/backend/vcs/VcsSourceRepositoryNotFoundError",
	"@maple/backend/vcs/VcsSourceFileNotFoundError",
])

// BOUNDARY: a failure value from the tracer, or the cause a sandbox error carries.
/** The GitHub client's wording for a rate limit, which carries its wait in seconds. */
const GITHUB_RATE_LIMITED = /^GitHub rate limited \(retry after (\d+)s\)/

/** The wait a GitHub rate limit asks for, when `message` is one. */
export const githubRateLimitWait = (message: string): number | undefined => {
	const seconds = GITHUB_RATE_LIMITED.exec(message)?.[1]
	return seconds === undefined ? undefined : Number(seconds)
}

const isRateLimitedLookup = (cause: unknown): boolean =>
	tagOf(cause) === "@maple/http/errors/IntegrationsUpstreamError" &&
	Predicate.hasProperty(cause, "message") &&
	typeof cause.message === "string" &&
	githubRateLimitWait(cause.message) !== undefined

const tagOf = (value: unknown): string | undefined =>
	Predicate.hasProperty(value, "_tag") && typeof value._tag === "string" ? value._tag : undefined

/**
 * Failures a tag cannot single out, judged on the value: the SDK's MCP protocol error for a call to
 * a tool that does not exist, and repository sandbox failures `fromSandboxError` hands the model as
 * a fixable call or one to retry later (a missing capability stays an Error). Both export `Ok`.
 *
 * BOUNDARY: the tracer hands over a cause's raw failure values.
 */
export const isAnticipatedMcpFailure = (error: unknown): boolean => {
	switch (tagOf(error)) {
		case "ProtocolError":
			return Predicate.hasProperty(error, "code") && CLIENT_PROTOCOL_CODES.has(error.code)
		case "@maple/backend/sandbox/SandboxTimeoutError":
		case "@maple/backend/sandbox/SandboxOutputLimitError":
			return true
		case "@maple/backend/sandbox/SandboxUnsupportedRequestError":
			return Predicate.hasProperty(error, "feature") && error.feature !== "runtime"
		case "@maple/backend/sandbox/SandboxSpawnError":
			return (
				Predicate.hasProperty(error, "cause") &&
				(CALLER_SPAWN_CAUSES.has(tagOf(error.cause)) || isRateLimitedLookup(error.cause))
			)
		default:
			return false
	}
}

/**
 * Longest failure message a span or a transcript keeps. A ClickHouse syntax error arrives with the
 * whole offending query inlined, and on a retry loop it would land once per attempt.
 */
export const MAX_FAILURE_MESSAGE_CHARS = 500

/** A failure message cut to {@link MAX_FAILURE_MESSAGE_CHARS}, for a span attribute. */
export const spanFailureMessage = (message: string): string =>
	Str.slice(0, MAX_FAILURE_MESSAGE_CHARS)(message)

/**
 * Record an expected MCP 4xx on the current span and log it at Warn.
 *
 * A no-op for any other failure, so it is safe to hang off a broad `tapError`:
 * genuine failures keep their Error span and are logged by their own handler.
 * The error itself stays in the typed Effect error channel either way — only
 * span recording changes here.
 */
export const recordExpectedMcpFailure = (
	error: { readonly _tag: string; readonly message: string },
	logMessage: string,
): Effect.Effect<void> => {
	const status = expectedStatusByTag.get(error._tag)
	if (status === undefined) return Effect.void
	return Effect.annotateCurrentSpan({
		"error.type": error._tag,
		"http.response.status_code": status,
		// On the span too, so a tool's failure reasons are one query rather than a join to logs.
		"maple.mcp.error.message": spanFailureMessage(error.message),
	}).pipe(
		Effect.andThen(
			Effect.logWarning(logMessage).pipe(
				Effect.annotateLogs({ "error.message": error.message, "error.type": error._tag }),
			),
		),
	)
}
