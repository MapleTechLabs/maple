import type { ClickHouseTableDiffEntry } from "@maple/domain/http"

export interface SchemaApplyPlan {
	/** Tables and materialized views Apply will create. */
	readonly create: ReadonlyArray<string>
	/** Tables Apply will `ADD COLUMN` to, with the columns it adds. */
	readonly addColumns: ReadonlyArray<{ readonly name: string; readonly columns: ReadonlyArray<string> }>
	/** Drift Apply leaves alone: wrong-kind objects, type mismatches, extra columns. */
	readonly leftAlone: ReadonlyArray<string>
}

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
	const leftAlone = entries.flatMap((entry) =>
		entry.status === "wrong_kind" ||
		(entry.status === "drifted" &&
			(entry.kind !== "table" || entry.columnDrifts.some((drift) => drift.kind !== "missing")))
			? [entry.name]
			: [],
	)
	return { create, addColumns, leftAlone }
}
