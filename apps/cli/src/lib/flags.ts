import * as Flag from "effect/unstable/cli/Flag"

export const since = Flag.String("since").pipe(
	Flag.withDescription("Relative window ending now: 30m, 6h, 7d, 2w (default: 6h)"),
	Flag.withDefault("6h"),
)

export const start = Flag.optional(
	Flag.String("start").pipe(
		Flag.withDescription(
			"Window start: 'YYYY-MM-DD HH:mm:ss' (UTC) or ISO-8601, e.g. 2026-09-25T22:00:00Z",
		),
	),
)

export const end = Flag.optional(
	Flag.String("end").pipe(Flag.withDescription("Window end, same formats as --start (default: now)")),
)

export const service = Flag.optional(
	Flag.String("service").pipe(Flag.withAlias("s"), Flag.withDescription("Filter by service name")),
)

export const environment = Flag.optional(
	Flag.String("env").pipe(
		Flag.withAlias("e"),
		Flag.withDescription("Filter by deployment environment (e.g. production, staging)"),
	),
)

/** `--limit`/`-n` with the given default; zero or negative is a parse error, not an empty page. */
export const limitWithDefault = (defaultValue: number) =>
	Flag.Int("limit").pipe(
		Flag.withAlias("n"),
		Flag.withDescription(`Maximum number of results (default: ${defaultValue})`),
		Flag.withDefault(defaultValue),
		Flag.filter(
			(n) => n >= 1,
			() => "a whole number of at least 1",
		),
	)

export const limit = limitWithDefault(20)

export const offset = Flag.Int("offset").pipe(
	Flag.withDescription("Skip this many results, for paging (default: 0)"),
	Flag.withDefault(0),
	Flag.filter(
		(n) => n >= 0,
		() => "zero or a positive whole number",
	),
)

export const hasError = Flag.Boolean("errors").pipe(
	Flag.withDescription("Only include traces with errors"),
	Flag.withDefault(false),
)

export const search = Flag.optional(
	Flag.String("search").pipe(Flag.withAlias("q"), Flag.withDescription("Search text (substring match)")),
)

/** Severity levels as OTel names them; matching is case-insensitive. */
export const SEVERITIES = ["TRACE", "DEBUG", "INFO", "WARN", "WARNING", "ERROR", "FATAL"] as const

export const severity = Flag.optional(
	Flag.String("severity").pipe(
		Flag.withDescription("Filter by log severity: trace, debug, info, warn, error, fatal"),
		Flag.filter(
			(value) => SEVERITIES.some((s) => s === value.trim().toUpperCase()),
			() => "one of trace, debug, info, warn, error, fatal (any case)",
		),
		Flag.map((value) => value.trim().toUpperCase()),
	),
)

export const traceId = Flag.optional(Flag.String("trace-id").pipe(Flag.withDescription("Filter by trace ID")))
