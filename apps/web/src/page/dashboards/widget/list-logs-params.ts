import { normalizeKey, parseWhereClause } from "@maple/domain/where-clause"
import type { ListLogsInput } from "@maple/web-data/warehouse/logs"

// `buildListLogsParams`: a logs list
// widget's where clause as `list_logs` column filters, unsupported clauses reported as warnings.

type IncludeKey = "service" | "severity" | "deploymentEnv" | "namespace"
type ExcludeKey = "excludedServices" | "excludedSeverities" | "excludedDeploymentEnvs" | "excludedNamespaces"
type MatchModeKey = "deploymentEnvMatchMode" | "namespaceMatchMode"

interface ListLogsField {
	readonly include: IncludeKey
	readonly exclude: ExcludeKey
	readonly matchMode?: MatchModeKey
}

const LIST_LOGS_FIELDS = new Map<string, ListLogsField>([
	["service.name", { include: "service", exclude: "excludedServices" }],
	["severity", { include: "severity", exclude: "excludedSeverities" }],
	[
		"deployment.environment",
		{ include: "deploymentEnv", exclude: "excludedDeploymentEnvs", matchMode: "deploymentEnvMatchMode" },
	],
	[
		"service.namespace",
		{ include: "namespace", exclude: "excludedNamespaces", matchMode: "namespaceMatchMode" },
	],
])

interface Acc {
	readonly included: Readonly<Partial<Record<IncludeKey | "search", string>>>
	readonly excluded: Readonly<Partial<Record<ExcludeKey, ReadonlyArray<string>>>>
	readonly matchModes: Readonly<Partial<Record<MatchModeKey, "contains">>>
	readonly warnings: ReadonlyArray<string>
}

const withoutKey = <K extends string>(record: Readonly<Partial<Record<K, "contains">>>, key: K) =>
	Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key))

export const buildListLogsParams = (
	whereClause: string,
	limit: number,
): { params: ListLogsInput; warnings: ReadonlyArray<string> } => {
	const parsed = parseWhereClause(whereClause)
	const start: Acc = {
		included: {},
		excluded: {},
		matchModes: {},
		warnings: parsed.warnings.map((warning) => warning.message),
	}
	const done = parsed.clauses.reduce<Acc>((acc, clause) => {
		const key = normalizeKey(clause.key)
		const typedKey = clause.rawKey ?? clause.key
		const warn = (warning: string): Acc => ({ ...acc, warnings: [...acc.warnings, warning] })
		if (key === "search" || key === "body")
			return clause.operator === "=" || clause.operator === "contains"
				? { ...acc, included: { ...acc.included, search: clause.value } }
				: warn(
						`Logs list filter ${typedKey} supports only = and contains; ignoring ${clause.operator}`,
					)
		const field = LIST_LOGS_FIELDS.get(key)
		if (field === undefined) return warn(`Unsupported logs list filter ignored: ${typedKey}`)
		const mode = field.matchMode
		if (clause.operator === "=" || (clause.operator === "contains" && mode !== undefined))
			return {
				...acc,
				included: { ...acc.included, [field.include]: clause.value },
				matchModes:
					mode === undefined
						? acc.matchModes
						: clause.operator === "contains"
							? { ...acc.matchModes, [mode]: "contains" }
							: withoutKey(acc.matchModes, mode),
			}
		if (clause.operator === "!=")
			return {
				...acc,
				excluded: {
					...acc.excluded,
					[field.exclude]: [...(acc.excluded[field.exclude] ?? []), clause.value],
				},
			}
		const supported = mode !== undefined ? "=, != and contains" : "= and !="
		return warn(`Logs list filter ${typedKey} supports only ${supported}; ignoring ${clause.operator}`)
	}, start)
	return {
		params: { limit, ...done.included, ...done.excluded, ...done.matchModes },
		warnings: done.warnings,
	}
}
