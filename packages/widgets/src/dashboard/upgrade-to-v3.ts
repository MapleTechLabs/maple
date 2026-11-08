// BOUNDARY-FILE: This module intentionally carries opaque values; callers decode them before domain use.
import type { QuerySet } from "@maple/query-model"
import { MARKDOWN_STATIC_ENDPOINT, QUERY_ENDPOINT_RESULT_KINDS, RAW_SQL_ENDPOINT } from "./legacy-endpoints"
import type { WidgetDataSourceTransformV2 } from "./shared/transform"
import type { WidgetDataSourceV3 } from "./v3/data-source"
import { Array as Arr } from "effect"

/**
 * The v2 `{ endpoint, params }` data-source bag read as the v3 discriminated union.
 *
 * The one-shot Postgres backfill that applied this to every stored document has
 * run and been deleted (#1746); what remains is the per-source conversion. Total
 * and idempotent: anything unrecognised becomes a `route` that keeps the endpoint
 * and bag verbatim, and a source already in v3 is returned as-is.
 */

type V3DataSource = typeof WidgetDataSourceV3.Type
type Transform = typeof WidgetDataSourceTransformV2.Type

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

/** Spread-if-present, so an absent `optionalKey` never becomes a present `undefined`. */
const put = <K extends string, V>(key: K, value: V | undefined): Record<string, never> | { [P in K]: V } => {
	if (value === undefined) return {}
	// SAFETY: the computed property is created from the same generic key and value returned by this helper.
	return { [key]: value } as { [P in K]: V }
}

/**
 * TOTAL and never throws, however malformed the stored source. Everything
 * is read defensively and anything unrecognised falls through to a `route`, the
 * arm that preserves an arbitrary endpoint plus an opaque bag verbatim. The worst case is therefore "stored unchanged in
 * a different envelope", never "data dropped".
 */
export const fromLegacyDataSource = (dataSource: unknown): V3DataSource => {
	if (!isRecord(dataSource)) return { kind: "static" }

	const transform = isRecord(dataSource.transform)
		? put("transform", dataSource.transform as Transform)
		: {}
	const endpoint = typeof dataSource.endpoint === "string" ? dataSource.endpoint : null
	const params = isRecord(dataSource.params) ? dataSource.params : {}

	if (endpoint === null) {
		// Already v3? Return it as-is so the conversion is idempotent.
		if (typeof dataSource.kind === "string") return dataSource as V3DataSource
		return { kind: "static", ...transform }
	}

	if (endpoint === MARKDOWN_STATIC_ENDPOINT) return { kind: "static", ...transform }

	if (endpoint === RAW_SQL_ENDPOINT) {
		return {
			kind: "raw_sql",
			// The v2 accessor coerced a missing `sql` to "" and callers relied on it;
			// v3 makes the field required, so the coercion happens here instead —
			// once, at the boundary, rather than on every read.
			sql: typeof params.sql === "string" ? params.sql : "",
			...put("displayType", typeof params.displayType === "string" ? params.displayType : undefined),
			...put(
				"granularitySeconds",
				typeof params.granularitySeconds === "number" ? params.granularitySeconds : undefined,
			),
			...transform,
		}
	}

	const resultKind = QUERY_ENDPOINT_RESULT_KINDS[endpoint]
	if (resultKind !== undefined) {
		return {
			kind: "query",
			resultShape: resultKind,
			queries: Arr.isArray(params.queries)
				? (Arr.map(params.queries, repairQueryDraft) as QuerySet["queries"])
				: [],
			...put(
				"formulas",
				Arr.isArray(params.formulas) ? (params.formulas as QuerySet["formulas"]) : undefined,
			),
			...put(
				"comparison",
				isRecord(params.comparison) ? (params.comparison as QuerySet["comparison"]) : undefined,
			),
			...put("defaultLimit", typeof params.defaultLimit === "number" ? params.defaultLimit : undefined),
			...put("limit", typeof params.limit === "number" ? params.limit : undefined),
			...put(
				"columns",
				Arr.isArray(params.columns) ? (params.columns as ReadonlyArray<string>) : undefined,
			),
			...transform,
		}
	}

	return {
		kind: "route",
		endpoint,
		...put("params", isRecord(dataSource.params) ? dataSource.params : undefined),
		...transform,
	}
}

/**
 * Repairs the one v2-era looseness that stops a stored draft decoding.
 *
 * `queries` lived inside the untyped `params` bag, so nothing ever validated the
 * drafts inside it and the UI wrote `limit` as a number on some paths while the
 * schema declares `string | undefined`. v3 hoists `queries` to a typed field, so
 * those rows stop decoding — and a rejected document is refused by the writable
 * path, which locks the entire dashboard out of editing over one widget.
 *
 * Coerce rather than reject, exactly as `v1ToV2` does for the three fields v2
 * closed: `String(50)` is the value the builder round-trips to anyway, so a
 * repaired draft behaves identically to how it rendered before.
 *
 * Deliberately narrow. This is not a general-purpose draft repair — it fixes the
 * single field that the production dry run proved is stored off-type, and any
 * other malformation still quarantines loudly rather than being papered over.
 */
const repairQueryDraft = (draft: unknown): unknown => {
	if (!isRecord(draft) || typeof draft.limit !== "number") return draft
	return { ...draft, limit: String(draft.limit) }
}

/**
 * Already v3 iff it carries a string `kind`.
 *
 * Structural rather than a flag or a version column, so converting twice is a no-op.
 */
export const isV3DataSource = (dataSource: unknown): boolean =>
	isRecord(dataSource) && typeof dataSource.kind === "string"
