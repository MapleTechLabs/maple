import type { OrgId } from "@maple/domain"
import { compile, type CHQuery, type NeedsSelect } from "@maple-dev/effect-orm/clickhouse"
import { Effect, Schema } from "effect"
import { rawCompiledQuery } from "./raw-sql"

/** A query `compile` accepts, whatever it selects. */
type CompileTarget<Output extends Record<string, unknown>> = CHQuery<any, Output> & NeedsSelect<Output>

export interface PeriodCompareWindows {
	readonly orgId: OrgId
	readonly currentStart: string
	readonly currentEnd: string
	readonly previousStart: string
	readonly previousEnd: string
}

/**
 * One builder over a current and a previous window, UNION ALL'd into a single
 * statement whose rows carry a `period` of `"current"` or `"previous"`.
 *
 * The service-free constraint is `CompiledQueryRowSchema`'s, pushed one level
 * up: a row schema decodes bytes off a socket, so it cannot ask for a service,
 * and a struct is service-free exactly when its fields are.
 */
export const compilePeriodCompare = <
	Output extends Record<string, unknown>,
	Fields extends Schema.Struct.Fields & Record<PropertyKey, Schema.Codec<any, any, never, never>>,
>(
	query: CompileTarget<Output>,
	windows: PeriodCompareWindows,
	/**
	 * The branch query's row schema, required rather than optional: the union
	 * is handwritten SQL, so nothing derives a schema for it, and without one
	 * it decoded nothing: on a backend that quotes 64-bit integers every
	 * count came back as a string. Taking a `Schema.Struct` rather than a bare
	 * `Schema` is what makes the `period` field spreadable below, and every
	 * `*RowSchema` export already is one. See ./schema.ts.
	 */
	rowSchema: Schema.Struct<Fields>,
) =>
	Effect.gen(function* () {
		const { orgId } = windows
		const current = yield* compile(
			query,
			{ orgId, startTime: windows.currentStart, endTime: windows.currentEnd },
			{ skipFormat: true },
		)
		const previous = yield* compile(
			query,
			{ orgId, startTime: windows.previousStart, endTime: windows.previousEnd },
			{ skipFormat: true },
		)
		return rawCompiledQuery({
			sql:
				`SELECT 'current' AS period, * FROM (\n${current.sql}\n)\n` +
				`UNION ALL\n` +
				`SELECT 'previous' AS period, * FROM (\n${previous.sql}\n)\n` +
				`FORMAT JSON`,
			reason: "param-varied-union",
			justification:
				"One builder over a current and a previous window; params are substituted once per compile, so a single CHQuery cannot carry both.",
			// Both branches are the same builder over different windows, so the
			// union is scoped exactly when the branch is.
			tenantScope:
				current.tenantScope === "single-tenant" && previous.tenantScope === "single-tenant"
					? "single-tenant"
					: "cross-tenant",
			// `period` is typed as a plain String, not a `"current" | "previous"`
			// literal union: the row schema describes the WIRE type, and the SQL
			// catalog's analyzer sweep decodes a synthetic zero-value row where a
			// String column is `""`, which a literal union would reject.
			rowSchema: Schema.Struct({ period: Schema.String, ...rowSchema.fields }),
		})
	})
