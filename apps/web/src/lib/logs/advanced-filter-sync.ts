import { Match, Array as Arr, String as Str } from "effect"
import {
	type AttributeFilterEntry,
	type AttributeMaps,
	parseFilterClauses,
} from "../query-builder/where-clause-filters"

// The `/logs` advanced filter: a where clause mapped onto the logs URL params (the traces
// counterpart is lib/traces/advanced-filter-sync.ts).

/** The logs URL params a where clause can set. */
export interface LogsClauseFields {
	services?: ReadonlyArray<string>
	severities?: ReadonlyArray<string>
	deploymentEnvs?: ReadonlyArray<string>
	deploymentEnvMatchMode?: "contains"
	namespaces?: ReadonlyArray<string>
	namespaceMatchMode?: "contains"
	excludedServices?: ReadonlyArray<string>
	excludedSeverities?: ReadonlyArray<string>
	excludedDeploymentEnvs?: ReadonlyArray<string>
	excludedNamespaces?: ReadonlyArray<string>
	search?: string
	attributeFilters?: ReadonlyArray<AttributeFilterEntry>
	resourceAttributeFilters?: ReadonlyArray<AttributeFilterEntry>
}

export type LogsSearchLike = LogsClauseFields & { whereClause?: string }

interface ParsedLogsClause extends AttributeMaps {
	service?: string
	severity?: string
	deploymentEnv?: string
	namespace?: string
	body?: string
	deploymentEnvMatchMode?: "contains"
	namespaceMatchMode?: "contains"
	excludedServices: string[]
	excludedSeverities: string[]
	excludedDeploymentEnvs: string[]
	excludedNamespaces: string[]
}

const emptyClause = (): ParsedLogsClause => ({
	attributeFilters: [],
	resourceAttributeFilters: [],
	excludedServices: [],
	excludedSeverities: [],
	excludedDeploymentEnvs: [],
	excludedNamespaces: [],
})

// `ListLogsRequest` has a substring mode for these two only.
const CONTAINS_FIELD_KEYS = new Set(["deployment.environment", "service.namespace"])
const EQUALITY_FIELD_KEYS = new Set(["service.name", "severity"])

export function parseLogsWhereClause(whereClause: string | undefined): {
	filters: ParsedLogsClause
	/** One message per clause that was not applied, for the editor to show. */
	warnings: string[]
} {
	const { filters, warnings } = parseFilterClauses(
		whereClause,
		emptyClause,
		(parsed, { clause, key, pushAttribute, unsupported }) => {
			const isNegated = clause.operator === "!="
			const isEquality = clause.operator === "=" || isNegated
			if (EQUALITY_FIELD_KEYS.has(key) && !isEquality) {
				unsupported("= and !=")
				return parsed
			}
			if (CONTAINS_FIELD_KEYS.has(key) && !isEquality && clause.operator !== "contains") {
				unsupported("=, != and contains")
				return parsed
			}
			if (key === "body" && clause.operator !== "contains") {
				unsupported("contains")
				return parsed
			}
			const mode = clause.operator === "contains" ? ("contains" as const) : undefined
			return Match.value(key).pipe(
				Match.when("service.name", () =>
					isNegated
						? { ...parsed, excludedServices: [...parsed.excludedServices, clause.value] }
						: { ...parsed, service: clause.value },
				),
				Match.when("severity", () =>
					isNegated
						? { ...parsed, excludedSeverities: [...parsed.excludedSeverities, clause.value] }
						: { ...parsed, severity: clause.value },
				),
				Match.when("deployment.environment", () =>
					isNegated
						? {
								...parsed,
								excludedDeploymentEnvs: [...parsed.excludedDeploymentEnvs, clause.value],
							}
						: { ...parsed, deploymentEnv: clause.value, deploymentEnvMatchMode: mode },
				),
				Match.when("service.namespace", () =>
					isNegated
						? { ...parsed, excludedNamespaces: [...parsed.excludedNamespaces, clause.value] }
						: { ...parsed, namespace: clause.value, namespaceMatchMode: mode },
				),
				// The list's text search is a substring match on the body; an empty one matches all.
				Match.when("body", () => ({
					...parsed,
					body: clause.value === "" ? undefined : clause.value,
				})),
				// Any other key is a log attribute (`request.id = "x"` means `attr.request.id`).
				Match.orElse(() => {
					pushAttribute()
					return parsed
				}),
			)
		},
	)
	return { filters, warnings }
}

const nonEmpty = <A>(values: ReadonlyArray<A>) => (values.length > 0 ? values : undefined)

/** The params a clause sets, holding only the keys it actually sets. */
function clauseFields(filters: ParsedLogsClause): LogsClauseFields {
	const fields: LogsClauseFields = {}
	if (filters.service !== undefined) fields.services = [filters.service]
	if (filters.severity !== undefined) fields.severities = [filters.severity]
	if (filters.deploymentEnv !== undefined) {
		fields.deploymentEnvs = [filters.deploymentEnv]
		fields.deploymentEnvMatchMode = filters.deploymentEnvMatchMode
	}
	if (filters.namespace !== undefined) {
		fields.namespaces = [filters.namespace]
		fields.namespaceMatchMode = filters.namespaceMatchMode
	}
	if (filters.body !== undefined) fields.search = filters.body
	const lists = {
		excludedServices: nonEmpty(filters.excludedServices),
		excludedSeverities: nonEmpty(filters.excludedSeverities),
		excludedDeploymentEnvs: nonEmpty(filters.excludedDeploymentEnvs),
		excludedNamespaces: nonEmpty(filters.excludedNamespaces),
		attributeFilters: nonEmpty(filters.attributeFilters),
		resourceAttributeFilters: nonEmpty(filters.resourceAttributeFilters),
	}
	return Arr.reduce(
		Arr.filter(
			// @effect-diagnostics-next-line preferEffectRecord:off -- a fixed-key struct; Rec.toEntries would need a cast
			Object.entries(lists),
			([, value]) => value !== undefined,
		),
		fields,
		(acc, [key, value]) => ({ ...acc, [key]: value }),
	)
}

/** The params a clause sets (`services`, `attributeFilters`, ...). */
export const clauseParams = (whereClause: string | undefined): ReadonlyArray<string> =>
	whereClause === undefined
		? []
		: // @effect-diagnostics-next-line preferEffectRecord:off -- a fixed-key struct; Rec.keys would need a cast
			Object.keys(clauseFields(parseLogsWhereClause(whereClause).filters))

/** Every param a clause can set, cleared: what an empty clause leaves. */
export const CLEARED_CLAUSE_FIELDS = {
	whereClause: undefined,
	services: undefined,
	severities: undefined,
	deploymentEnvs: undefined,
	deploymentEnvMatchMode: undefined,
	namespaces: undefined,
	namespaceMatchMode: undefined,
	excludedServices: undefined,
	excludedSeverities: undefined,
	excludedDeploymentEnvs: undefined,
	excludedNamespaces: undefined,
	search: undefined,
	attributeFilters: undefined,
	resourceAttributeFilters: undefined,
} satisfies { readonly [K in keyof Required<LogsSearchLike>]: undefined }

/**
 * The clause into the search: params the previous clause set are dropped first, so removing a
 * clause removes its filter; params it never set (sidebar picks) stay. An empty clause clears
 * every param a clause can set, as on /traces.
 */
export function applyLogsWhereClause<S extends LogsSearchLike>(
	search: S,
	whereClause: string,
): S & LogsSearchLike {
	const trimmed = Str.trim(whereClause)
	if (trimmed === "") return { ...search, ...CLEARED_CLAUSE_FIELDS }
	const previous =
		search.whereClause === undefined ? {} : clauseFields(parseLogsWhereClause(search.whereClause).filters)
	const carried = Arr.reduce(
		// @effect-diagnostics-next-line preferEffectRecord:off -- a fixed-key struct; Rec.keys would need a cast
		Object.keys(previous),
		{ ...search },
		(acc, key) => ({ ...acc, [key]: undefined }),
	)
	return { ...carried, ...clauseFields(parseLogsWhereClause(trimmed).filters), whereClause: trimmed }
}
