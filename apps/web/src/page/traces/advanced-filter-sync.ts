import { parseBoolean, parseNumber } from "@maple/domain/where-clause"
import { Match, String as Str } from "effect"
import {
	type AttributeFilterEntry,
	type AttributeMaps,
	parseFilterClauses,
} from "../../lib/query-builder/where-clause-filters"

export {
	type AttributeFilterEntry,
	formatAttributeClause,
} from "../../lib/query-builder/where-clause-filters"

export interface TracesSearchLike {
	services?: string[]
	spanNames?: string[]
	hasError?: boolean
	minDurationMs?: number
	maxDurationMs?: number
	httpMethods?: string[]
	httpStatusCodes?: string[]
	deploymentEnvs?: string[]
	namespaces?: string[]
	startTime?: string
	endTime?: string
	rootOnly?: boolean
	whereClause?: string
	attributeFilters?: readonly AttributeFilterEntry[]
	resourceAttributeFilters?: readonly AttributeFilterEntry[]
	serviceMatchMode?: FilterMatchMode
	spanNameMatchMode?: FilterMatchMode
	deploymentEnvMatchMode?: FilterMatchMode
	namespaceMatchMode?: FilterMatchMode
	excludedServices?: string[]
	excludedSpanNames?: string[]
	excludedDeploymentEnvs?: string[]
	excludedNamespaces?: string[]
	excludedHttpMethods?: string[]
	excludedHttpStatusCodes?: string[]
}

type FilterMatchMode = "contains"

export interface ParsedWhereClauseFilters extends AttributeMaps {
	service?: string
	spanName?: string
	deploymentEnv?: string
	namespace?: string
	httpMethod?: string
	httpStatusCode?: string
	hasError?: true
	rootOnly?: false
	minDurationMs?: number
	maxDurationMs?: number
	matchModes?: Partial<Record<string, FilterMatchMode>>
	excludedServices?: string[]
	excludedSpanNames?: string[]
	excludedDeploymentEnvs?: string[]
	excludedNamespaces?: string[]
	excludedHttpMethods?: string[]
	excludedHttpStatusCodes?: string[]
}

// Named fields whose search param has a substring match mode.
const CONTAINS_FIELD_KEYS = new Set([
	"service.name",
	"span.name",
	"deployment.environment",
	"service.namespace",
])
// HTTP method and status compile to an exact attribute match, so they take = and != only.
const EQUALITY_FIELD_KEYS = new Set(["http.method", "http.status_code"])
const SCALAR_KEYS = new Set(["has_error", "root_only", "min_duration_ms", "max_duration_ms"])

const emptyFilters = (): ParsedWhereClauseFilters => ({ attributeFilters: [], resourceAttributeFilters: [] })

export function parseWhereClause(whereClause: string | undefined): {
	filters: ParsedWhereClauseFilters
	/** One message per clause that was not applied, for the editor to show. */
	warnings: string[]
} {
	return parseFilterClauses(
		whereClause,
		emptyFilters,
		(parsed, { clause, key, warnings, pushAttribute, unsupported }) => {
			const isContains = clause.operator === "contains"
			const isNegated = clause.operator === "!="

			const withMatchMode = (
				next: ParsedWhereClauseFilters,
				modeKey: string,
			): ParsedWhereClauseFilters =>
				isContains ? { ...next, matchModes: { ...next.matchModes, [modeKey]: "contains" } } : next

			// Named fields have an include list and an exclude list, and some a substring
			// mode. Any other operator would silently turn into an exact match on the
			// value, so it is reported instead.
			const isEqualityOperator = clause.operator === "=" || isNegated
			if (CONTAINS_FIELD_KEYS.has(key) && !isEqualityOperator && !isContains) {
				unsupported("=, != and contains")
				return parsed
			}
			if (EQUALITY_FIELD_KEYS.has(key) && !isEqualityOperator) {
				unsupported("= and !=")
				return parsed
			}
			if (SCALAR_KEYS.has(key) && clause.operator !== "=") {
				unsupported("=")
				return parsed
			}

			const invalid = () => {
				warnings.push(`Invalid ${key} value ignored: ${clause.value}`)
				return parsed
			}

			return Match.value(key).pipe(
				Match.when("service.name", () =>
					isNegated
						? { ...parsed, excludedServices: [...(parsed.excludedServices ?? []), clause.value] }
						: withMatchMode({ ...parsed, service: clause.value }, "service"),
				),
				Match.when("span.name", () =>
					isNegated
						? {
								...parsed,
								excludedSpanNames: [...(parsed.excludedSpanNames ?? []), clause.value],
							}
						: withMatchMode({ ...parsed, spanName: clause.value }, "spanName"),
				),
				Match.when("deployment.environment", () =>
					isNegated
						? {
								...parsed,
								excludedDeploymentEnvs: [
									...(parsed.excludedDeploymentEnvs ?? []),
									clause.value,
								],
							}
						: withMatchMode({ ...parsed, deploymentEnv: clause.value }, "deploymentEnv"),
				),
				Match.when("service.namespace", () =>
					isNegated
						? {
								...parsed,
								excludedNamespaces: [...(parsed.excludedNamespaces ?? []), clause.value],
							}
						: withMatchMode({ ...parsed, namespace: clause.value }, "namespace"),
				),
				Match.when("http.method", () =>
					isNegated
						? {
								...parsed,
								excludedHttpMethods: [...(parsed.excludedHttpMethods ?? []), clause.value],
							}
						: { ...parsed, httpMethod: clause.value },
				),
				Match.when("http.status_code", () =>
					isNegated
						? {
								...parsed,
								excludedHttpStatusCodes: [
									...(parsed.excludedHttpStatusCodes ?? []),
									clause.value,
								],
							}
						: { ...parsed, httpStatusCode: clause.value },
				),
				Match.when("has_error", () => {
					const boolValue = parseBoolean(clause.value)
					if (boolValue === null) return invalid()
					return { ...parsed, hasError: boolValue === true ? (true as const) : undefined }
				}),
				Match.when("root_only", () => {
					const boolValue = parseBoolean(clause.value)
					if (boolValue === null) return invalid()
					return { ...parsed, rootOnly: boolValue === false ? (false as const) : undefined }
				}),
				Match.when("min_duration_ms", () => {
					const numeric = parseNumber(clause.value)
					return numeric === null ? invalid() : { ...parsed, minDurationMs: numeric }
				}),
				Match.when("max_duration_ms", () => {
					const numeric = parseNumber(clause.value)
					return numeric === null ? invalid() : { ...parsed, maxDurationMs: numeric }
				}),
				// Any other key is a span attribute (`request.id = "x"` means `attr.request.id`).
				Match.orElse(() => {
					pushAttribute()
					return parsed
				}),
			)
		},
	)
}

type ClauseFields = Omit<TracesSearchLike, "startTime" | "endTime" | "whereClause">

/**
 * The search params a clause owns, containing only the keys it actually sets.
 * The key set is what tells `applyWhereClause` which params to drop when a
 * later edit of the clause no longer produces them.
 */
function clauseFields(filters: ParsedWhereClauseFilters): ClauseFields {
	const modes = filters.matchModes ?? {}
	const fields: ClauseFields = {}

	if (filters.service) {
		fields.services = [filters.service]
		fields.serviceMatchMode = modes.service
	}
	if (filters.spanName) {
		fields.spanNames = [filters.spanName]
		fields.spanNameMatchMode = modes.spanName
	}
	if (filters.deploymentEnv) {
		fields.deploymentEnvs = [filters.deploymentEnv]
		fields.deploymentEnvMatchMode = modes.deploymentEnv
	}
	if (filters.namespace) {
		fields.namespaces = [filters.namespace]
		fields.namespaceMatchMode = modes.namespace
	}
	if (filters.httpMethod) fields.httpMethods = [filters.httpMethod]
	if (filters.httpStatusCode) fields.httpStatusCodes = [filters.httpStatusCode]
	if (filters.hasError !== undefined) fields.hasError = filters.hasError
	if (filters.rootOnly !== undefined) fields.rootOnly = filters.rootOnly
	if (filters.minDurationMs !== undefined) fields.minDurationMs = filters.minDurationMs
	if (filters.maxDurationMs !== undefined) fields.maxDurationMs = filters.maxDurationMs
	if (filters.attributeFilters.length > 0) fields.attributeFilters = filters.attributeFilters
	if (filters.resourceAttributeFilters.length > 0) {
		fields.resourceAttributeFilters = filters.resourceAttributeFilters
	}
	if (filters.excludedServices !== undefined && filters.excludedServices.length > 0)
		fields.excludedServices = filters.excludedServices
	if (filters.excludedSpanNames !== undefined && filters.excludedSpanNames.length > 0)
		fields.excludedSpanNames = filters.excludedSpanNames
	if (filters.excludedDeploymentEnvs !== undefined && filters.excludedDeploymentEnvs.length > 0) {
		fields.excludedDeploymentEnvs = filters.excludedDeploymentEnvs
	}
	if (filters.excludedNamespaces !== undefined && filters.excludedNamespaces.length > 0)
		fields.excludedNamespaces = filters.excludedNamespaces
	if (filters.excludedHttpMethods !== undefined && filters.excludedHttpMethods.length > 0)
		fields.excludedHttpMethods = filters.excludedHttpMethods
	if (filters.excludedHttpStatusCodes !== undefined && filters.excludedHttpStatusCodes.length > 0) {
		fields.excludedHttpStatusCodes = filters.excludedHttpStatusCodes
	}

	return fields
}

/**
 * One-way transform: parses a where clause string and merges the parsed
 * filter values into the search params. Does NOT reverse-sync checkboxes
 * back into whereClause text.
 *
 * Params the previous clause contributed are dropped first, so removing a
 * clause removes its filter from the URL instead of leaving it stuck there.
 * Params the previous clause never set (sidebar selections) are kept.
 */
export function applyWhereClause(search: TracesSearchLike, whereClause: string): TracesSearchLike {
	const trimmed = Str.trim(whereClause)

	if (!trimmed) {
		return {
			...search,
			whereClause: undefined,
			services: undefined,
			spanNames: undefined,
			hasError: undefined,
			minDurationMs: undefined,
			maxDurationMs: undefined,
			httpMethods: undefined,
			httpStatusCodes: undefined,
			deploymentEnvs: undefined,
			namespaces: undefined,
			rootOnly: undefined,
			attributeFilters: undefined,
			resourceAttributeFilters: undefined,
			serviceMatchMode: undefined,
			spanNameMatchMode: undefined,
			deploymentEnvMatchMode: undefined,
			namespaceMatchMode: undefined,
			excludedServices: undefined,
			excludedSpanNames: undefined,
			excludedDeploymentEnvs: undefined,
			excludedNamespaces: undefined,
			excludedHttpMethods: undefined,
			excludedHttpStatusCodes: undefined,
		}
	}

	const carried: TracesSearchLike = { ...search }
	if (search.whereClause) {
		// @effect-diagnostics-next-line preferEffectRecord:off -- not a record type; Rec.keys would need a cast
		for (const key of Object.keys(clauseFields(parseWhereClause(search.whereClause).filters))) {
			delete carried[key as keyof ClauseFields]
		}
	}

	return {
		...carried,
		...clauseFields(parseWhereClause(trimmed).filters),
		whereClause: trimmed,
	}
}
