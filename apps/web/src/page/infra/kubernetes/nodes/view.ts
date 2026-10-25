import { deriveHostStatus, type HostStatus } from "../../../../components/infra/format"
import { statusLabel } from "../../../../components/infra/severity-tokens"
import { formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { TONE_FILL, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
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
import { icon } from "../../../../ui/icon"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { fleetBand } from "../../kit/fleet-band"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import * as InstallModalView from "../../kit/install-modal-view"
import { countLabel, searchToolbar, setupEmpty } from "../../kit/page-parts"
import { filteredEmpty } from "../../../kit/signal-empty-state"
import { type SortAccessors, sortRowsBy } from "../../../kit/table-sort"
import { kubernetesViewTabs } from "../../kit/view-tabs"
import { Message } from "./message"
import { type Model, NODE_LIST_LIMIT, type NodeFacets, type NodeRow } from "./model"
import { DEFAULT_PRESET, filtersOf } from "./update"
import { nodeTable, nodeTableLoading } from "./view-table"

// `NodesPage` and `NodesFilterSidebarView`.

type H = HtmlBuilder<Message>

const STATUS_CELLS: ReadonlyArray<Readonly<{ status: HostStatus; hint: string; tone: Tone }>> = [
	{ status: "active", hint: "reporting", tone: "info" },
	{ status: "idle", hint: "quiet >1m", tone: "warn" },
	{ status: "ended", hint: "silent >5m", tone: "neutral" },
]

const STATUS_SEGMENT = new Map<HostStatus, string>([
	["active", TONE_FILL.info],
	["idle", TONE_FILL.warn],
	["ended", "bg-muted-foreground/40"],
])

const NODE_SORT_ACCESSORS: SortAccessors<NodeRow> = new Map<string, (row: NodeRow) => string | number>([
	["nodeName", (row) => row.nodeName],
	["cpuUtilization", (row) => row.cpuUtilization],
	["memoryUtilization", (row) => row.memoryUtilization],
	["uptime", (row) => row.uptime],
	["lastSeen", (row) => row.lastSeen],
])

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const loadedRail = (h: H, model: Model, facets: NodeFacets): Html => {
	const hasFilters = Object.values(filtersOf(model.search)).some((values) => (values?.length ?? 0) > 0)
	if (!hasFilters && Object.values(facets).every((options) => options.length === 0)) return filterSidebarEmpty(h)
	const section = (title: string, facet: "nodeNames" | "clusters" | "environments", isSearchable: boolean) =>
		filterSection(h, {
			title,
			options: facets[facet === "nodeNames" ? "nodes" : facet],
			selected: model.search[facet] ?? [],
			isSearchable,
			sections: model.filterSections,
			toSectionsMessage: toSections,
			onToggle: (name) => Message.ToggledFacetOption({ facet, name }),
		})
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.facets.data) }, [
		filterSidebarHeader(h, hasFilters ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(h, "nodes-filters", [
			section("Node", "nodeNames", true),
			section("Cluster", "clusters", false),
			section("Environment", "environments", false),
		]),
	])
}

const toInstall = (message: InstallModal.Message) => Message.GotInstallMessage({ message })

const nodeList = (h: H, model: Model, nodes: ReadonlyArray<NodeRow>, inputs: PageViewInputs): Html => {
	const isWaiting = AsyncData.isRefreshing(model.nodes.data)
	const hasStructuredFilter = Object.values(filtersOf(model.search)).some((values) => (values?.length ?? 0) > 0)
	if (nodes.length === 0 && !hasStructuredFilter)
		return setupEmpty(h, {
			icon: icon(h, "ServerIcon", { size: 16 }),
			title: "No nodes reporting yet",
			description:
				"Install the Maple Kubernetes Helm chart so the kubelet stats receiver can start collecting per-node metrics.",
			actionLabel: "Install the Helm chart",
			onAction: toInstall(InstallModal.Message.ClickedOpen()),
			docs: "kubernetes",
			modal: h.submodel({ slotId: "install-modal", model: model.install, view: InstallModalView.mountedView, toParentMessage: toInstall }),
		})
	const endTime = model.frame.window?.endTime ?? ""
	const statusOf = (node: NodeRow) => deriveHostStatus(node.lastSeen, endTime)
	const searchText = model.search.q ?? ""
	const q = searchText.trim().toLowerCase()
	const statusScope = model.search.status
	const named = q === "" ? nodes : nodes.filter((node) => node.nodeName.toLowerCase().includes(q))
	const filtered = statusScope === undefined ? named : named.filter((node) => statusOf(node) === statusScope)
	const countOf = (status: HostStatus) => nodes.filter((node) => statusOf(node) === status).length
	return h.div(
		[h.Class(cn("space-y-5", refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			fleetBand(h, {
				total: nodes.length,
				noun: "node",
				caption: "share of the fleet by collector freshness",
				segments: STATUS_CELLS.map(({ status }) => ({
					key: statusLabel(status).toLowerCase(),
					count: countOf(status),
					className: STATUS_SEGMENT.get(status) ?? "",
				})),
				cells: STATUS_CELLS.map(({ status, hint, tone }) => ({
					scope: status,
					label: statusLabel(status),
					hint,
					value: countOf(status),
					tone,
				})),
				activeScope: statusScope,
				onScopeChange: (status) => Message.ChangedStatus({ status }),
				isWaiting,
			}),
			h.div(
				[h.Class("space-y-3")],
				[
					searchToolbar(h, {
						id: "infra-nodes-search",
						value: searchText,
						onInput: (value) => Message.ChangedQuery({ value }),
						onClear: Message.ChangedQuery({ value: "" }),
						placeholder: "Search nodes…",
						trailing:
							nodes.length >= NODE_LIST_LIMIT
								? `${formatNumber(filtered.length)} of the ${formatNumber(NODE_LIST_LIMIT)} most recently seen nodes`
								: countLabel(filtered.length, filtered.length, "node"),
					}),
					(q !== "" || statusScope !== undefined) && filtered.length === 0
						? filteredEmpty(h, {
								noun: "nodes",
								className: "py-12",
								icon: icon(h, "MagnifierIcon", { size: 16 }),
								title: "No nodes match",
								description:
									q !== ""
										? `Nothing named “${searchText}” in this scope.`
										: "Nothing in this scope right now, which is good news.",
								onClear: Message.ClickedClearSearch(),
								clearLabel: q !== "" ? "Clear search" : "Show all nodes",
							})
						: nodeTable(h, sortRowsBy(filtered, model.sort, NODE_SORT_ACCESSORS), {
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

const nodesArea = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.nodes.data, {
		onEmpty: () => nodeTableLoading(h),
		onFailure: (failure) => errorState(h, { failure, title: "Failed to load nodes", onRetry: Message.ClickedRetryNodes() }),
		onData: (nodes) => nodeList(h, model, nodes, inputs),
	})

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents")],
		[
			dashboardPage(
				h,
				{
					title: "Kubernetes",
					actions: Frame.controls(h, model.frame, { search: model.search, defaultPreset: DEFAULT_PRESET }, toFrame),
					tabs: kubernetesViewTabs(h, "nodes", model.search),
					filters: filtersRail(h, model),
				},
				[nodesArea(h, model, inputs)],
			),
		],
	),
)

const filtersRail = (h: H, model: Model): Html =>
	AsyncData.matchData(model.facets.data, {
		onEmpty: () => filterSidebarLoading(h, 3),
		onFailure: (failure) => filterSidebarError(h, failure),
		onData: (facets) => loadedRail(h, model, facets),
	})
