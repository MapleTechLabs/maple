import {
	normalizeKey,
	parseBoolean,
	parseNumber,
	parseWhereClause as parseWhereClauses,
	quoteWhereValue,
	type Operator,
	type ParsedClause,
} from "@maple/domain/where-clause"
import { Match, Array as Arr, String as Str } from "effect"

/**
 * How an attribute filter compares. Absent means equality; `exists` carries an
 * empty value. `!=`, `!contains` and `!exists` are the same modes with `negated`.
 */
export type AttributeMatchMode = "contains" | "exists" | "gt" | "gte" | "lt" | "lte"

interface AttributeFilterEntryLeaf {
	key: string
	value: string
	matchMode?: AttributeMatchMode
	negated?: boolean
}

interface AttributeFilterEntry extends AttributeFilterEntryLeaf {
	/** The other members of an `(a OR b)` group; the entry matches when any member does. */
	or?: readonly AttributeFilterEntryLeaf[]
}

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

export interface ParsedWhereClauseFilters {
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
	attributeFilters: AttributeFilterEntry[]
	resourceAttributeFilters: AttributeFilterEntry[]
	matchModes?: Partial<Record<string, FilterMatchMode>>
	excludedServices?: string[]
	excludedSpanNames?: string[]
	excludedDeploymentEnvs?: string[]
	excludedNamespaces?: string[]
	excludedHttpMethods?: string[]
	excludedHttpStatusCodes?: string[]
}

interface AttributeOperator {
	readonly matchMode?: AttributeMatchMode
	readonly negated?: true
}

const ATTRIBUTE_OPERATORS = {
	"=": {},
	"!=": { negated: true },
	contains: { matchMode: "contains" },
	"!contains": { matchMode: "contains", negated: true },
	exists: { matchMode: "exists" },
	"!exists": { matchMode: "exists", negated: true },
	">": { matchMode: "gt" },
	">=": { matchMode: "gte" },
	"<": { matchMode: "lt" },
	"<=": { matchMode: "lte" },
} satisfies Record<Operator, AttributeOperator>

const MATCH_MODE_OPERATORS = {
	contains: ["contains", "!contains"],
	exists: ["exists", "!exists"],
	gt: [">", ">"],
	gte: [">=", ">="],
	lt: ["<", "<"],
	lte: ["<=", "<="],
} as const satisfies Record<AttributeMatchMode, readonly [string, string]>

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

/** The where-clause operator an attribute filter entry reads back as. */
export function attributeFilterOperator(entry: Pick<AttributeFilterEntry, "matchMode" | "negated">): string {
	if (!entry.matchMode) return entry.negated ? "!=" : "="
	const [positive, negative] = MATCH_MODE_OPERATORS[entry.matchMode]
	return entry.negated ? negative : positive
}

/** An attribute filter entry as where-clause text; a group reads back as `(a OR b)`. */
export function formatAttributeClause(prefix: string, entry: AttributeFilterEntry): string {
	if (entry.or !== undefined && entry.or.length > 0) {
		const { or, ...first } = entry
		return `(${Arr.join(
			Arr.map([first, ...or], (member) => formatAttributeClause(prefix, member)),
			" OR ",
		)})`
	}
	const operator = attributeFilterOperator(entry)
	if (entry.matchMode === "exists") return `${prefix}${entry.key} ${operator}`
	return `${prefix}${entry.key} ${operator} ${quoteWhereValue(entry.value)}`
}

export function parseWhereClause(whereClause: string | undefined): {
	filters: ParsedWhereClauseFilters
	/** One message per clause that was not applied, for the editor to show. */
	warnings: string[]
} {
	if (!whereClause || !Str.trim(whereClause)) {
		return {
			filters: { attributeFilters: [], resourceAttributeFilters: [] },
			warnings: [],
		}
	}

	const parsedClauses = parseWhereClauses(Str.trim(whereClause), { orGroups: true })
	const clauses = parsedClauses.clauses
	const warnings = Arr.map(parsedClauses.warnings, (warning) => warning.message)

	let parsed: ParsedWhereClauseFilters = { attributeFilters: [], resourceAttributeFilters: [] }

	// Takes `parsed` and `warnings` as parameters (shadowing the outer ones) so an
	// OR group member can be applied alone, with its warnings kept apart.
	const applyClause = (
		parsed: ParsedWhereClauseFilters,
		clause: ParsedClause,
		warnings: string[],
	): ParsedWhereClauseFilters => {
		const key = normalizeKey(clause.key)
		const isContains = clause.operator === "contains"
		const isNegated = clause.operator === "!="

		function setMatchMode(modeKey: string) {
			if (isContains) {
				parsed.matchModes ??= {}
				parsed.matchModes[modeKey] = "contains"
			}
		}

		// Attribute keys are case-sensitive, so they come from the key as typed.
		const typedKey = Str.trim(clause.rawKey ?? clause.key)
		function pushAttribute(target: AttributeFilterEntry[], attributeKey: string, label: string) {
			if (!attributeKey) {
				warnings.push(`Missing attribute key ignored: ${label}`)
				return
			}
			if (target.length >= 5) {
				warnings.push(`Maximum of 5 filters per attribute map; ignoring ${label}`)
				return
			}
			const { matchMode, negated }: AttributeOperator = ATTRIBUTE_OPERATORS[clause.operator]
			const valueless = matchMode === "exists"
			target.push({
				key: attributeKey,
				value: valueless ? "" : clause.value,
				...(matchMode ? { matchMode } : undefined),
				...(negated ? { negated } : undefined),
			})
		}

		if (Str.startsWith("attr.")(key)) {
			pushAttribute(parsed.attributeFilters, Str.trim(Str.slice(5)(typedKey)), typedKey)
			return parsed
		}

		if (Str.startsWith("resource.")(key)) {
			pushAttribute(parsed.resourceAttributeFilters, Str.trim(Str.slice(9)(typedKey)), typedKey)
			return parsed
		}

		const unsupported = (supported: string) => {
			warnings.push(`${clause.key} supports only ${supported}; ignoring ${clause.operator}`)
			return parsed
		}

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

		parsed = Match.value(key).pipe(
			Match.when("service.name", () => {
				if (isNegated) {
					const current = parsed.excludedServices ?? []
					return { ...parsed, excludedServices: [...current, clause.value] }
				}
				setMatchMode("service")
				return { ...parsed, service: clause.value }
			}),
			Match.when("span.name", () => {
				if (isNegated) {
					const current = parsed.excludedSpanNames ?? []
					return { ...parsed, excludedSpanNames: [...current, clause.value] }
				}
				setMatchMode("spanName")
				return { ...parsed, spanName: clause.value }
			}),
			Match.when("deployment.environment", () => {
				if (isNegated) {
					const current = parsed.excludedDeploymentEnvs ?? []
					return { ...parsed, excludedDeploymentEnvs: [...current, clause.value] }
				}
				setMatchMode("deploymentEnv")
				return { ...parsed, deploymentEnv: clause.value }
			}),
			Match.when("service.namespace", () => {
				if (isNegated) {
					const current = parsed.excludedNamespaces ?? []
					return { ...parsed, excludedNamespaces: [...current, clause.value] }
				}
				setMatchMode("namespace")
				return { ...parsed, namespace: clause.value }
			}),
			Match.when("http.method", () => {
				if (isNegated) {
					const current = parsed.excludedHttpMethods ?? []
					return { ...parsed, excludedHttpMethods: [...current, clause.value] }
				}
				return { ...parsed, httpMethod: clause.value }
			}),
			Match.when("http.status_code", () => {
				if (isNegated) {
					const current = parsed.excludedHttpStatusCodes ?? []
					return { ...parsed, excludedHttpStatusCodes: [...current, clause.value] }
				}
				return { ...parsed, httpStatusCode: clause.value }
			}),
			Match.when("has_error", () => {
				const boolValue = parseBoolean(clause.value)
				if (boolValue === null) {
					warnings.push(`Invalid ${key} value ignored: ${clause.value}`)
					return parsed
				}
				return { ...parsed, hasError: boolValue === true ? (true as const) : undefined }
			}),
			Match.when("root_only", () => {
				const boolValue = parseBoolean(clause.value)
				if (boolValue === null) {
					warnings.push(`Invalid ${key} value ignored: ${clause.value}`)
					return parsed
				}
				return { ...parsed, rootOnly: boolValue === false ? (false as const) : undefined }
			}),
			Match.when("min_duration_ms", () => {
				const numeric = parseNumber(clause.value)
				if (numeric === null) {
					warnings.push(`Invalid ${key} value ignored: ${clause.value}`)
					return parsed
				}
				return { ...parsed, minDurationMs: numeric }
			}),
			Match.when("max_duration_ms", () => {
				const numeric = parseNumber(clause.value)
				if (numeric === null) {
					warnings.push(`Invalid ${key} value ignored: ${clause.value}`)
					return parsed
				}
				return { ...parsed, maxDurationMs: numeric }
			}),
			// Any other key is a span attribute (`request.id = "x"` means `attr.request.id`).
			Match.orElse(() => {
				pushAttribute(parsed.attributeFilters, typedKey, typedKey)
				return parsed
			}),
		)
		return parsed
	}

	for (const clause of clauses) parsed = applyClause(parsed, clause, warnings)

	// An `(a OR b)` group: each member goes through `applyClause` on its own, and
	// must land as exactly one attribute entry on the same map. Named fields
	// (service, span name, http method, ...) are single-valued params and cannot
	// be OR-ed.
	for (const group of parsedClauses.groups) {
		const label = `(${Arr.join(
			Arr.map(group, (c) => c.rawKey ?? c.key),
			" OR ",
		)})`
		const members: Array<{
			map: "attributeFilters" | "resourceAttributeFilters"
			entry: AttributeFilterEntry
		}> = []
		for (const clause of group) {
			const memberWarnings: string[] = []
			const alone = applyClause(
				{ attributeFilters: [], resourceAttributeFilters: [] },
				clause,
				memberWarnings,
			)
			const setsOtherField = Arr.some(
				// @effect-diagnostics-next-line preferEffectRecord:off -- not a record type; Rec.toEntries would need a cast
				Object.entries(alone),
				([field, value]) =>
					field !== "attributeFilters" &&
					field !== "resourceAttributeFilters" &&
					value !== undefined,
			)
			const map =
				alone.attributeFilters.length === 1 && alone.resourceAttributeFilters.length === 0
					? "attributeFilters"
					: alone.resourceAttributeFilters.length === 1 && alone.attributeFilters.length === 0
						? "resourceAttributeFilters"
						: undefined
			const entry = map === undefined ? undefined : alone[map][0]
			if (memberWarnings.length > 0 || setsOtherField || map === undefined || entry === undefined) {
				members.length = 0
				warnings.push(`OR group ignored: only attribute filters can be OR-ed: ${label}`)
				break
			}
			members.push({ map, entry })
		}
		const [first, ...rest] = members
		if (first === undefined) continue
		if (Arr.some(rest, (m) => m.map !== first.map)) {
			warnings.push(`OR group ignored: its members mix span and resource attributes: ${label}`)
			continue
		}
		if (parsed[first.map].length >= 5) {
			warnings.push(`Maximum of 5 filters per attribute map; ignoring ${label}`)
			continue
		}
		parsed = {
			...parsed,
			[first.map]: [...parsed[first.map], { ...first.entry, or: Arr.map(rest, (m) => m.entry) }],
		}
	}

	return {
		filters: parsed,
		warnings,
	}
}

export function toWhereClause(filters: ParsedWhereClauseFilters): string | undefined {
	const clauses: string[] = []
	const modes = filters.matchModes ?? {}

	function op(key: string): string {
		return modes[key] === "contains" ? "contains" : "="
	}

	if (filters.service) {
		clauses.push(`service.name ${op("service")} ${quoteWhereValue(filters.service)}`)
	}

	if (filters.spanName) {
		clauses.push(`span.name ${op("spanName")} ${quoteWhereValue(filters.spanName)}`)
	}

	if (filters.deploymentEnv) {
		clauses.push(
			`deployment.environment ${op("deploymentEnv")} ${quoteWhereValue(filters.deploymentEnv)}`,
		)
	}

	if (filters.namespace) {
		clauses.push(`service.namespace ${op("namespace")} ${quoteWhereValue(filters.namespace)}`)
	}

	if (filters.httpMethod) {
		clauses.push(`http.method = ${quoteWhereValue(filters.httpMethod)}`)
	}

	if (filters.httpStatusCode) {
		clauses.push(`http.status_code = ${quoteWhereValue(filters.httpStatusCode)}`)
	}

	if (filters.hasError === true) {
		clauses.push("has_error = true")
	}

	if (filters.rootOnly === false) {
		clauses.push("root_only = false")
	}

	if (typeof filters.minDurationMs === "number") {
		clauses.push(`min_duration_ms = ${String(filters.minDurationMs)}`)
	}

	if (typeof filters.maxDurationMs === "number") {
		clauses.push(`max_duration_ms = ${String(filters.maxDurationMs)}`)
	}

	for (const af of filters.attributeFilters) {
		clauses.push(formatAttributeClause("attr.", af))
	}

	for (const rf of filters.resourceAttributeFilters) {
		clauses.push(formatAttributeClause("resource.", rf))
	}

	for (const v of filters.excludedServices ?? []) {
		clauses.push(`service.name != ${quoteWhereValue(v)}`)
	}
	for (const v of filters.excludedSpanNames ?? []) {
		clauses.push(`span.name != ${quoteWhereValue(v)}`)
	}
	for (const v of filters.excludedDeploymentEnvs ?? []) {
		clauses.push(`deployment.environment != ${quoteWhereValue(v)}`)
	}
	for (const v of filters.excludedNamespaces ?? []) {
		clauses.push(`service.namespace != ${quoteWhereValue(v)}`)
	}
	for (const v of filters.excludedHttpMethods ?? []) {
		clauses.push(`http.method != ${quoteWhereValue(v)}`)
	}
	for (const v of filters.excludedHttpStatusCodes ?? []) {
		clauses.push(`http.status_code != ${quoteWhereValue(v)}`)
	}

	if (clauses.length === 0) {
		return undefined
	}

	return Arr.join(clauses, " AND ")
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
