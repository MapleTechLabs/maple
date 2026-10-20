import type { BranchCandidate } from "../../../components/infra/planetscale/branch-selection"

// PlanetScale list filters. The search fields themselves are in `route/search.ts`.

export interface PlanetScaleFilters {
	readonly branches?: ReadonlyArray<string>
	readonly branchStates?: ReadonlyArray<string>
	readonly branchRoles?: ReadonlyArray<string>
	readonly branchContains?: string
}

export type PlanetScaleFilterKey = keyof PlanetScaleFilters
export type ListFilterKey = Exclude<PlanetScaleFilterKey, "branchContains">

export const FILTER_CHIP_LABEL = {
	branches: "branch",
	branchStates: "state",
	branchRoles: "role",
	branchContains: "branch~",
} as const satisfies Record<PlanetScaleFilterKey, string>

export const FILTER_SECTION_LABEL = {
	branches: "Branch",
	branchStates: "State",
	branchRoles: "Role",
	branchContains: "Branch contains",
} as const satisfies Record<PlanetScaleFilterKey, string>

const LIST_KEYS: ReadonlyArray<ListFilterKey> = ["branches", "branchStates", "branchRoles"]

type FilterSearch = Readonly<{
	branch?: string
	branches?: ReadonlyArray<string>
	branchStates?: ReadonlyArray<string>
	branchRoles?: ReadonlyArray<string>
	branchContains?: string
}>

const nonEmpty = (values: ReadonlyArray<string> | undefined) =>
	values !== undefined && values.length > 0 ? values : undefined

/** `filtersFromSearch`: the legacy `?branch=` reads as a one-branch selection when `branches` is absent. */
export const filtersFromSearch = (search: FilterSearch): PlanetScaleFilters => {
	const legacy = search.branch !== undefined && search.branch !== "" ? [search.branch] : undefined
	return {
		branches: nonEmpty(search.branches) ?? legacy,
		branchStates: nonEmpty(search.branchStates),
		branchRoles: nonEmpty(search.branchRoles),
		branchContains: search.branchContains === "" ? undefined : search.branchContains,
	}
}

export interface ActiveFilterChip {
	readonly key: PlanetScaleFilterKey
	readonly value: string
	readonly label: string
}

export const activeFilterChips = (filters: PlanetScaleFilters): ReadonlyArray<ActiveFilterChip> => [
	...LIST_KEYS.flatMap((key) =>
		(filters[key] ?? []).map((value) => ({ key, value, label: `${FILTER_CHIP_LABEL[key]}:${value}` })),
	),
	...(filters.branchContains !== undefined && filters.branchContains !== ""
		? [
				{
					key: "branchContains" as const,
					value: filters.branchContains,
					label: `${FILTER_CHIP_LABEL.branchContains}${filters.branchContains}`,
				},
			]
		: []),
]

export const hasActiveFilters = (filters: PlanetScaleFilters): boolean =>
	activeFilterChips(filters).length > 0

export const toggleFilterValue = (
	current: ReadonlyArray<string> | undefined,
	value: string,
): ReadonlyArray<string> | undefined => {
	const values = current ?? []
	const next = values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]
	return next.length === 0 ? undefined : next
}

export type BranchState = "ready" | "provisioning" | "excluded" | "untracked"

export const branchStateOf = (candidate: BranchCandidate): BranchState => {
	if (candidate.excluded) return "excluded"
	if (candidate.unknownToInventory) return "untracked"
	return candidate.ready ? "ready" : "provisioning"
}

export const BRANCH_STATE_LABEL = {
	ready: "Ready",
	provisioning: "Provisioning",
	excluded: "Excluded",
	untracked: "Not in inventory",
} as const satisfies Record<BranchState, string>

export type BranchRole = "production" | "development"

export const branchRoleOf = (candidate: BranchCandidate): BranchRole =>
	candidate.production ? "production" : "development"

export const BRANCH_ROLE_LABEL = {
	production: "Production",
	development: "Development",
} as const satisfies Record<BranchRole, string>

export const applyBranchFilters = (
	candidates: ReadonlyArray<BranchCandidate>,
	filters: PlanetScaleFilters,
): ReadonlyArray<BranchCandidate> => {
	const contains = filters.branchContains?.toLowerCase() ?? ""
	return candidates.filter(
		(candidate) =>
			(filters.branches === undefined || filters.branches.includes(candidate.name)) &&
			(filters.branchStates === undefined || filters.branchStates.includes(branchStateOf(candidate))) &&
			(filters.branchRoles === undefined || filters.branchRoles.includes(branchRoleOf(candidate))) &&
			(contains === "" || candidate.name.toLowerCase().includes(contains)),
	)
}

export const soleSelectedBranch = (filters: PlanetScaleFilters): string | null =>
	filters.branches !== undefined && filters.branches.length === 1 ? (filters.branches[0] ?? null) : null
