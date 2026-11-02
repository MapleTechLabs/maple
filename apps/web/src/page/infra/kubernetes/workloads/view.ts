import { deriveHostStatus, severityLevel } from "../../../../components/infra/format"
import { formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { errorState } from "../../../../ui/error-state"
import { filterSection } from "../../../../ui/filters/filter-section"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../../../ui/filters/filter-sidebar"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../../ui/empty"
import { icon } from "../../../../ui/icon"
import { segmentedSelect } from "../../../../ui/segmented-select"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { fleetBand } from "../../kit/fleet-band"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import * as InstallModalView from "../../kit/install-modal-view"
import { countLabel, searchToolbar, setupEmpty } from "../../kit/page-parts"
import { emptyActions, filteredEmpty } from "../../../kit/signal-empty-state"
import { type SortAccessors, sortRowsBy } from "../../../kit/table-sort"
import { kubernetesViewTabs } from "../../kit/view-tabs"
import { type Facet, Message, type WorkloadScope } from "./message"
import {
	type Model,
	WORKLOAD_LIST_LIMIT,
	type WorkloadFacets,
	type WorkloadKind,
	type WorkloadRow,
} from "./model"
import { DEFAULT_PRESET, filtersOf, kindOf } from "./update"
import { workloadTable, workloadTableLoading } from "./view-table"

// `WorkloadsPage` and `WorkloadsFilterSidebarView`.

type H = HtmlBuilder<Message>

export const KIND_OPTIONS: ReadonlyArray<Readonly<{ value: WorkloadKind; label: string }>> = [
	{ value: "deployment", label: "Deployments" },
	{ value: "statefulset", label: "StatefulSets" },
	{ value: "daemonset", label: "DaemonSets" },
	{ value: "job", label: "Jobs" },
]

const SORT_ACCESSORS: SortAccessors<WorkloadRow> = new Map<string, (row: WorkloadRow) => string | number>([
	["workloadName", (row) => row.workloadName],
	["podCount", (row) => row.podCount],
	["restarts", (row) => row.restarts],
	["peakCpuLimitPct", (row) => row.peakCpuLimitPct],
	["peakMemoryLimitPct", (row) => row.peakMemoryLimitPct],
	["lastSeen", (row) => row.lastSeen],
])

/** `scopeOf`: the worst pod's peak decides, so one pod at its limit marks the whole workload. */
const scopeOf = (workload: WorkloadRow, referenceTime: string): WorkloadScope | null => {
	if (deriveHostStatus(workload.lastSeen, referenceTime) === "ended") return "stale"
	const level = severityLevel(Math.max(workload.peakCpuLimitPct, workload.peakMemoryLimitPct))
	if (level === "crit") return "saturated"
	if (level === "warn") return "elevated"
	return null
}

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const loadedRail = (h: H, model: Model, facets: WorkloadFacets, label: string): Html => {
	const hasFilters = Object.values(filtersOf(model.search)).some((values) => (values?.length ?? 0) > 0)
	if (!hasFilters && Object.values(facets).every((options) => options.length === 0))
		return filterSidebarEmpty(h)
	const section = (
		title: string,
		facet: Facet,
		options: keyof WorkloadFacets,
		config: Readonly<{ isSearchable?: boolean; defaultOpen?: boolean }>,
	) =>
		filterSection(h, {
			title,
			options: facets[options],
			selected: model.search[facet] ?? [],
			isSearchable: config.isSearchable,
			defaultOpen: config.defaultOpen,
			sections: model.filterSections,
			toSectionsMessage: toSections,
			onToggle: (name) => Message.ToggledFacetOption({ facet, name }),
		})
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.facets.data) }, [
		filterSidebarHeader(h, hasFilters ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(h, "workloads-filters", [
			section(label, "workloadNames", "workloads", { isSearchable: true, defaultOpen: true }),
			section("Namespace", "namespaces", "namespaces", {}),
			section("Cluster", "clusters", "clusters", { defaultOpen: false }),
			section("Environment", "environments", "environments", { defaultOpen: false }),
			section("Compute type", "computeTypes", "computeTypes", { defaultOpen: false }),
		]),
	])
}

const toInstall = (message: InstallModal.Message) => Message.GotInstallMessage({ message })

/** The sidebar's presence probe (`useInfraSurfaces()`): any Kubernetes surface means the chart is in. */
const isClusterReporting = (presence: ReadonlyArray<string>): boolean =>
	presence.some((surface) => surface === "k8sPods" || surface === "k8sNodes" || surface === "k8sWorkloads")

/** The probe has not answered yet: install advice would flash before the cluster is known. */
const isProbePending = (inputs: PageViewInputs): boolean =>
	inputs.context.infra !== undefined &&
	inputs.context.infra.presence === null &&
	!inputs.context.infra.isPresenceFailed

const otherKinds = (h: H, kind: WorkloadKind): ReadonlyArray<Html> =>
	KIND_OPTIONS.filter((option) => option.value !== kind).map((option) =>
		button(
			h,
			{
				variant: "outline",
				size: "sm",
				attributes: [h.Key(option.value), h.OnClick(Message.ChangedKind({ kind: option.value }))],
			},
			["Show ", option.label],
		),
	)

/** The cluster already reports, so only this kind is missing: no install advice. */
const emptyKindInWindow = (h: H, kind: WorkloadKind, kindLabel: string): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "GridIcon", { size: 16 })]),
				emptyTitle(h, [`No ${kindLabel} in this window`]),
				emptyDescription(h, [
					"Your cluster is reporting, but no pod carried a ",
					`k8s.${kind}.name`,
					" attribute in this window.",
				]),
			]),
			emptyActions(h, otherKinds(h, kind)),
		],
		"py-16",
	)

const emptyKind = (h: H, model: Model, kind: WorkloadKind, kindLabel: string): Html =>
	setupEmpty(h, {
		icon: icon(h, "GridIcon", { size: 16 }),
		title: `No ${kindLabel} reporting yet`,
		description:
			"Maple aggregates pod metrics by k8s.deployment.name, k8s.statefulset.name, k8s.daemonset.name, and k8s.job.name. If the Helm chart is not installed yet, install it so the k8sattributes processor can tag pod metrics with their workload. If it is, try another workload kind.",
		actionLabel: "Install the Helm chart",
		onAction: toInstall(InstallModal.Message.ClickedOpen()),
		docs: "kubernetes",
		extra: otherKinds(h, kind),
		modal: h.submodel({
			slotId: "install-modal",
			model: model.install,
			view: InstallModalView.mountedView,
			toParentMessage: toInstall,
		}),
	})

const workloadList = (
	h: H,
	model: Model,
	workloads: ReadonlyArray<WorkloadRow>,
	inputs: PageViewInputs,
): Html => {
	const kind = kindOf(model.search)
	const kindLabel = KIND_OPTIONS.find((option) => option.value === kind)?.label ?? "Deployments"
	const isWaiting = AsyncData.isRefreshing(model.workloads.data)
	const hasStructuredFilter = Object.values(filtersOf(model.search)).some(
		(values) => (values?.length ?? 0) > 0,
	)
	if (workloads.length === 0 && !hasStructuredFilter) {
		if (isProbePending(inputs)) return workloadTableLoading(h)
		return isClusterReporting(inputs.context.infra?.presence ?? [])
			? emptyKindInWindow(h, kind, kindLabel)
			: emptyKind(h, model, kind, kindLabel)
	}
	const endTime = model.frame.window?.endTime ?? ""
	const scoped = workloads.map((workload) => ({ workload, scope: scopeOf(workload, endTime) }))
	const count = (target: WorkloadScope) => scoped.filter((entry) => entry.scope === target).length
	const saturated = count("saturated")
	const elevated = count("elevated")
	const scope = model.search.scope
	const searchText = model.search.q ?? ""
	const q = searchText.trim().toLowerCase()
	const filtered = scoped
		.filter((entry) => scope === undefined || entry.scope === scope)
		.map((entry) => entry.workload)
		.filter((workload) => q === "" || workload.workloadName.toLowerCase().includes(q))
	return h.div(
		[h.Class(cn("space-y-5", refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			fleetBand(h, {
				total: workloads.length,
				noun: kindLabel.slice(0, -1).toLowerCase(),
				caption: "share of the fleet by its busiest pod's peak",
				segments: [
					{
						key: "healthy",
						count: Math.max(workloads.length - saturated - elevated, 0),
						className: TONE_FILL.ok,
					},
					{ key: "elevated", count: elevated, className: TONE_FILL.warn },
					{ key: "saturated", count: saturated, className: TONE_FILL.crit },
				],
				cells: [
					{
						scope: "saturated",
						label: "Saturated",
						hint: "a pod ≥90%",
						value: saturated,
						tone: "crit",
					},
					{
						scope: "elevated",
						label: "Elevated",
						hint: "a pod ≥60%",
						value: elevated,
						tone: "warn",
					},
					{
						scope: "stale",
						label: "Stale collector",
						hint: ">5m",
						value: count("stale"),
						tone: "neutral",
					},
				],
				activeScope: scope,
				onScopeChange: (next) => Message.ChangedScope({ scope: next }),
				isWaiting,
			}),
			h.div(
				[h.Class("space-y-3")],
				[
					searchToolbar(h, {
						id: "infra-workloads-search",
						value: searchText,
						onInput: (value) => Message.ChangedQuery({ value }),
						onClear: Message.ChangedQuery({ value: "" }),
						placeholder: "Search workloads…",
						trailing:
							workloads.length >= WORKLOAD_LIST_LIMIT
								? `${formatNumber(filtered.length)} of the ${formatNumber(WORKLOAD_LIST_LIMIT)} least healthy workloads`
								: countLabel(filtered.length, filtered.length, "workload"),
						children: [
							segmentedSelect(h, {
								size: "xs",
								options: KIND_OPTIONS,
								value: kind,
								onChange: (next) => Message.ChangedKind({ kind: next }),
								ariaLabel: "Workload kind",
							}),
						],
					}),
					(q !== "" || scope !== undefined) && filtered.length === 0
						? filteredEmpty(h, {
								noun: "workloads",
								className: "py-12",
								icon: icon(h, "MagnifierIcon", { size: 16 }),
								title: "No workloads match",
								description:
									q !== ""
										? `Nothing named “${searchText}” in this scope.`
										: "Nothing in this scope right now, which is good news.",
								onClear: Message.ClickedClearSearch(),
								clearLabel: q !== "" ? "Clear search" : "Show all workloads",
							})
						: workloadTable(h, sortRowsBy(filtered, model.sort, SORT_ACCESSORS), {
								kind,
								sort: model.sort,
								isWaiting,
								referenceTime: endTime,
								nowMs: model.frame.nowMs,
								timeZone: inputs.context.timeZone,
							}),
				],
			),
		],
	)
}

const workloadsArea = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.workloads.data, {
		onEmpty: () => workloadTableLoading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load workloads",
				onRetry: Message.ClickedRetryWorkloads(),
			}),
		onData: (workloads) => workloadList(h, model, workloads, inputs),
	})

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const kind = kindOf(model.search)
	const kindLabel = KIND_OPTIONS.find((option) => option.value === kind)?.label ?? "Deployments"
	return h.div(
		[h.Class("contents")],
		[
			dashboardPage(
				h,
				{
					title: "Kubernetes",
					actions: Frame.controls(
						h,
						model.frame,
						{ search: model.search, defaultPreset: DEFAULT_PRESET },
						toFrame,
						AsyncData.isFailure(model.workloads.data),
					),
					tabs: kubernetesViewTabs(h, "workloads", model.search),
					filters: filtersRail(h, model, kindLabel.replace(/s$/, "")),
				},
				[workloadsArea(h, model, inputs)],
			),
		],
	)
})

const filtersRail = (h: H, model: Model, label: string): Html =>
	AsyncData.matchData(model.facets.data, {
		onEmpty: () => filterSidebarLoading(h, 4),
		onFailure: (failure) =>
			filterSidebarError(
				h,
				failure,
				undefined,
				Option.getOrUndefined(AsyncData.getError(model.workloads.data)),
			),
		onData: (facets) => loadedRail(h, model, facets, label),
	})
