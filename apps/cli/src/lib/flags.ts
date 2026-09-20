import * as Flag from "effect/unstable/cli/Flag"

export const since = Flag.String("since").pipe(
	Flag.withDescription("Relative time range (e.g. 30m, 1h, 6h, 24h, 7d)"),
	Flag.withDefault("6h"),
)

export const start = Flag.optional(
	Flag.String("start").pipe(Flag.withDescription("Absolute start time (YYYY-MM-DD HH:mm:ss UTC)")),
)

export const end = Flag.optional(
	Flag.String("end").pipe(Flag.withDescription("Absolute end time (YYYY-MM-DD HH:mm:ss UTC)")),
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

export const limit = Flag.Int("limit").pipe(
	Flag.withAlias("n"),
	Flag.withDescription("Maximum number of results"),
	Flag.withDefault(20),
)

export const offset = Flag.Int("offset").pipe(Flag.withDescription("Pagination offset"), Flag.withDefault(0))

export const hasError = Flag.Boolean("errors").pipe(
	Flag.withDescription("Only include traces with errors"),
	Flag.withDefault(false),
)

export const search = Flag.optional(
	Flag.String("search").pipe(Flag.withAlias("q"), Flag.withDescription("Search text (substring match)")),
)

export const severity = Flag.optional(
	Flag.String("severity").pipe(
		Flag.withDescription("Filter by log severity (TRACE/DEBUG/INFO/WARN/ERROR/FATAL)"),
	),
)

export const traceId = Flag.optional(Flag.String("trace-id").pipe(Flag.withDescription("Filter by trace ID")))
