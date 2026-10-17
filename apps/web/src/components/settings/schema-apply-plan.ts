import type { ClickHouseColumnDrift, ClickHouseTableDiffEntry } from "@maple/domain/http"

export interface SchemaApplyPlan {
	/** Tables and materialized views Apply will create. */
	readonly create: ReadonlyArray<string>
	/** Tables Apply will `ADD COLUMN` to, with the columns it adds. */
	readonly addColumns: ReadonlyArray<{ readonly name: string; readonly columns: ReadonlyArray<string> }>
	/**
	 * Drift Apply does not resolve, with why: wrong-kind objects, drifted views, type mismatches and
	 * extra columns. A table can appear here and in `addColumns` when it has both kinds of drift.
	 */
	readonly unresolved: ReadonlyArray<{ readonly name: string; readonly reason: string }>
}

const describeDrift = (drift: ClickHouseColumnDrift): string | null =>
	drift.kind === "type_mismatch"
		? `type mismatch on ${drift.column}`
		: drift.kind === "extra"
			? `extra column ${drift.column}`
			: null

/** Mirrors the apply workflow's additive pass (`reconcileSchemaSnapshot`): it never drops or retypes. */
export function schemaApplyPlan(entries: ReadonlyArray<ClickHouseTableDiffEntry>): SchemaApplyPlan {
	const create = entries.flatMap((entry) => (entry.status === "missing" ? [entry.name] : []))
	const addColumns = entries.flatMap((entry) => {
		if (entry.status !== "drifted" || entry.kind !== "table") return []
		const columns = entry.columnDrifts.flatMap((drift) =>
			drift.kind === "missing" ? [drift.column] : [],
		)
		return columns.length > 0 ? [{ name: entry.name, columns }] : []
	})
	const unresolved = entries.flatMap((entry) => {
		if (entry.status === "wrong_kind") {
			return [{ name: entry.name, reason: `exists as a ${entry.actualKind.replace("_", " ")}` }]
		}
		if (entry.status !== "drifted") return []
		// Views are never altered, so even their missing columns stay unresolved.
		if (entry.kind !== "table") return [{ name: entry.name, reason: "view definition drifted" }]
		const reasons = entry.columnDrifts.flatMap((drift) => describeDrift(drift) ?? [])
		return reasons.length > 0 ? [{ name: entry.name, reason: reasons.join(", ") }] : []
	})
	return { create, addColumns, unresolved }
}
