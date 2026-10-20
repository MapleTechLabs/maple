import type { BranchCandidate } from "../../../../components/infra/planetscale/branch-selection"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import { filterSection } from "../../../../ui/filters/filter-section"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../../../ui/filters/filter-sidebar"
import {
	BRANCH_ROLE_LABEL,
	BRANCH_STATE_LABEL,
	branchRoleOf,
	branchStateOf,
	FILTER_SECTION_LABEL,
	hasActiveFilters,
	type PlanetScaleFilters,
} from "../filters"
import { Message, type Model } from "./model"

// `PlanetScaleFilterSidebar`.

type H = HtmlBuilder<Message>

const STATES = ["ready", "provisioning", "excluded", "untracked"] as const
const ROLES = ["production", "development"] as const

const countBy = <K extends string>(
	keys: ReadonlyArray<K>,
	candidates: ReadonlyArray<BranchCandidate>,
	of: (c: BranchCandidate) => K,
) =>
	keys
		.map((name) => ({ name, count: candidates.filter((candidate) => of(candidate) === name).length }))
		.filter((option) => option.count > 0)

const isLabelled = <L extends Readonly<Record<string, string>>>(
	labels: L,
	name: string,
): name is Extract<keyof L, string> => Object.hasOwn(labels, name)

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

export const planetscaleSidebar = (
	h: H,
	model: Model,
	candidates: ReadonlyArray<BranchCandidate>,
	filters: PlanetScaleFilters,
	isLoading: boolean,
): Html => {
	if (isLoading) return filterSidebarLoading(h, 3)
	const hasFilters = hasActiveFilters(filters)
	if (candidates.length === 0 && !hasFilters) return filterSidebarEmpty(h)
	return filterSidebarFrame(h, {}, [
		filterSidebarHeader(h, hasFilters ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(h, "planetscale-filters", [
			filterSection(h, {
				title: FILTER_SECTION_LABEL.branches,
				options: candidates.map((candidate) => ({ name: candidate.name, count: 1 })),
				selected: filters.branches ?? [],
				isSearchable: true,
				defaultOpen: true,
				maxVisible: 8,
				sections: model.filterSections,
				toSectionsMessage: toSections,
				onToggle: (name) => Message.ToggledFilterOption({ key: "branches", name }),
			}),
			filterSection(h, {
				title: FILTER_SECTION_LABEL.branchStates,
				options: countBy(STATES, candidates, branchStateOf),
				selected: filters.branchStates ?? [],
				sections: model.filterSections,
				toSectionsMessage: toSections,
				onToggle: (name) => Message.ToggledFilterOption({ key: "branchStates", name }),
				getOptionLabel: (name) =>
					isLabelled(BRANCH_STATE_LABEL, name) ? BRANCH_STATE_LABEL[name] : name,
			}),
			filterSection(h, {
				title: FILTER_SECTION_LABEL.branchRoles,
				options: countBy(ROLES, candidates, branchRoleOf),
				selected: filters.branchRoles ?? [],
				sections: model.filterSections,
				toSectionsMessage: toSections,
				onToggle: (name) => Message.ToggledFilterOption({ key: "branchRoles", name }),
				getOptionLabel: (name) =>
					isLabelled(BRANCH_ROLE_LABEL, name) ? BRANCH_ROLE_LABEL[name] : name,
			}),
		]),
	])
}
