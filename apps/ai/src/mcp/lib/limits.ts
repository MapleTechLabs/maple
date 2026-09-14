/**
 * Clamps an agent-supplied `limit` to a safe range.
 *
 * MCP tools expose `limit` params to LLM agents, which have a strong incentive
 * to ask for large page sizes. Apply this helper in every tool handler before
 * passing the value to a Tinybird/ClickHouse query.
 *
 * A positive fraction floors to at least one: the request classes downstream
 * check `isInt` AND `minimum: 1`, and a `Schema.Class` constructor answers a
 * refused field by THROWING — `limit: 0.5` would be a defect, not a parameter
 * error.
 */
export function clampLimit(value: number | undefined, opts: { defaultValue: number; max: number }): number {
	const v = value ?? opts.defaultValue
	if (!Number.isFinite(v) || v <= 0) return opts.defaultValue
	return Math.min(Math.max(1, Math.floor(v)), opts.max)
}

/**
 * Clamps an agent-supplied `offset`. Deep pagination on ClickHouse scans the
 * skipped rows, so an unbounded offset is a foot-gun.
 */
export function clampOffset(value: number | undefined, opts: { max: number }): number {
	const v = value ?? 0
	if (!Number.isFinite(v) || v < 0) return 0
	return Math.min(Math.floor(v), opts.max)
}

/**
 * An agent-supplied text filter: trimmed, blank read as "no filter". `""` is
 * how an LLM says "unset", and a `Schema.Class` constructor answers a refused
 * field by THROWING. The ceiling is the published parameter's own check, so an
 * over-long filter is a parameter error rather than a silently different one.
 */
export function optionalText(value: string | undefined): string | undefined {
	const trimmed = value?.trim()
	return trimmed === undefined || trimmed === "" ? undefined : trimmed
}
