import type { CloudflareD1Database } from "@maple/db/client"
import { Binding } from "@maple/effect-cf"

// Structural guard for a Cloudflare D1 binding. effect-cf's `D1.Service` wraps
// `@effect/sql-d1` (for `sqlLayer()`); maple feeds the raw binding to drizzle
// instead, so we use the lower-level `Binding.Service` directly and keep
// `@effect/sql-d1` out of the worker bundle.
const isD1Database = (value: unknown): value is CloudflareD1Database => {
	if (typeof value !== "object" || value === null) return false
	const resource = value as Record<string, unknown>
	return (
		typeof resource.prepare === "function" &&
		typeof resource.batch === "function" &&
		typeof resource.exec === "function"
	)
}

/**
 * Validated `MAPLE_DB` D1 binding. `yield* MapleDb` resolves the raw
 * `CloudflareD1Database`; provide via `MapleDb.layer` (requires
 * `WorkerEnvironment`, supplied by `Worker.make`).
 */
export class MapleDb extends Binding.Service<MapleDb>()(
	"@maple/api/MapleDb",
	"MAPLE_DB",
	isD1Database,
) {}
