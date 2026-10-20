import { summarizePodRestarts } from "../../../../components/infra/pod-restarts"
import { formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { activeFilterChips } from "../../../../ui/filters/active-filter-chips"
import { icon } from "../../../../ui/icon"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { facetChips } from "../../kit/facets"
import { fleetBand, fleetBandLoading } from "../../kit/fleet-band"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import * as InstallModalView from "../../kit/install-modal-view"
import { offsetPager, pageRangeLabel } from "../../kit/offset-pager"
import { countLabel, searchToolbar, setupEmpty } from "../../kit/page-parts"
import { filteredEmpty } from "../../../kit/signal-empty-state"
import { kubernetesViewTabs, pickTimeSearch } from "../../kit/view-tabs"
import * as PeekView from "../peek/view"
import { MountPodPeek } from "../peek-rows"
import type { PodsPage } from "../pod-data"
import { podTable, podTableLoading } from "../pod-table"
import { PAGE_SIZE } from "./command"
import { type FilterParam, Message, type PodScope } from "./message"
import type { Model, PodCounts } from "./model"
import { DEFAULT_PRESET, filtersOf, pageIndexOf, peekOf, sortOf } from "./update"
import { filtersRail } from "./view-filters"

// `PodsPage` in `KubernetesShell`.

type H = HtmlBuilder<Message>

const FACETS: ReadonlyArray<Readonly<{ label: string; include: FilterParam; exclude: FilterParam }>> = [
	{ label: "Pod", include: "podNames", exclude: "excludedPodNames" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
	{ label: "Node", include: "nodeNames", exclude: "excludedNodeNames" },
	{ label: "Cluster", include: "clusters", exclude: "excludedClusters" },
	{ label: "Deployment", include: "deployments", exclude: "excludedDeployments" },
	{ label: "StatefulSet", include: "statefulsets", exclude: "excludedStatefulsets" },
	{ label: "DaemonSet", include: "daemonsets", exclude: "excludedDaemonsets" },
	{ label: "Job", include: "jobs", exclude: "excludedJobs" },
	{ label: "Environment", include: "environments", exclude: "excludedEnvironments" },
	{ label: "Compute type", include: "computeTypes", exclude: "excludedComputeTypes" },
]

const SCOPE_LABEL = new Map<PodScope, string>([
	["saturated", "at or above 90% of a limit"],
	["elevated", "at or above 60% of a limit"],
	["unbounded", "running with no limits set"],
	["ended", "no longer running"],
])

const summaryBand = (h: H, model: Model): Html =>
	AsyncData.matchData(model.summary.data, {
		onEmpty: () => fleetBandLoading(h, 4),
		onFailure: () => null,
		onData: (counts: PodCounts) =>
			fleetBand(h, {
				total: counts.livePods,
				noun: "live pod",
				caption: "share of the live fleet by peak utilization",
				segments: [
					{
						key: "healthy",
						count: Math.max(counts.livePods - counts.saturatedPods - counts.elevatedPods, 0),
						className: TONE_FILL.ok,
					},
					{ key: "elevated", count: counts.elevatedPods, className: TONE_FILL.warn },
					{ key: "saturated", count: counts.saturatedPods, className: TONE_FILL.crit },
				],
				cells: [
					{ scope: "saturated", label: "Saturated", hint: "≥90%", value: counts.saturatedPods, tone: "crit" },
					{ scope: "elevated", label: "Elevated", hint: "≥60%", value: counts.elevatedPods, tone: "warn" },
					{ scope: "unbounded", label: "No limits set", hint: "unbounded", value: counts.unboundedPods, tone: "warn" },
					{ scope: "ended", label: "Ended", hint: "not running", value: counts.endedPods, tone: "neutral" },
				],
				activeScope: model.search.scope,
				onScopeChange: (scope) => Message.ChangedScope({ scope }),
				isWaiting: AsyncData.isRefreshing(model.summary.data),
			}),
	})

const toInstall = (message: InstallModal.Message) => Message.GotInstallMessage({ message })

const nothingRunning = (h: H, endedPods: number): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "FolderIcon", { size: 16 })]),
				emptyTitle(h, ["Nothing running right now"]),
				emptyDescription(h, [
					`Every pod that reported in this window has since ended. Open the Ended scope to see the ${formatNumber(endedPods)} that ran.`,
				]),
			]),
			button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedShowEnded())] }, [
				"Show ended pods",
			]),
		],
		"py-16",
	)

const listArea = (h: H, model: Model, page: PodsPage, inputs: PageViewInputs): Html => {
	const isWaiting = AsyncData.isRefreshing(model.pods.data)
	const searchText = model.search.q ?? ""
	const scope = model.search.scope
	const offset = pageIndexOf(model) * PAGE_SIZE
	const hasStructuredFilter = Object.values(filtersOf(model.search)).some((values) => (values?.length ?? 0) > 0)
	const hasAnyNarrowing = hasStructuredFilter || searchText.trim() !== "" || scope !== undefined || offset > 0
	const endedPods = AsyncData.getOrElse(model.summary.data, () => null)?.endedPods ?? 0
	const pods = page.data
	if (pods.length === 0 && !hasAnyNarrowing && endedPods === 0)
		return setupEmpty(h, {
			icon: icon(h, "FolderIcon", { size: 16 }),
			title: "No pods reporting yet",
			description:
				"Install the Maple Kubernetes Helm chart so the kubelet stats receiver can start collecting per-pod CPU and memory metrics.",
			actionLabel: "Install the Helm chart",
			onAction: toInstall(InstallModal.Message.ClickedOpen()),
			docs: "kubernetes",
			modal: h.submodel({
				slotId: "install-modal",
				model: model.install,
				view: InstallModalView.mountedView,
				toParentMessage: toInstall,
			}),
		})
	if (pods.length === 0 && !hasAnyNarrowing) return nothingRunning(h, endedPods)
	const { sortBy, sortDir } = sortOf(model.search)
	return h.div(
		[
			h.Class(cn("space-y-3", refreshingClass(isWaiting))),
			...(isWaiting ? [h.AriaBusy(true)] : []),
			h.OnMount(MountPodPeek()),
		],
		[
			searchToolbar(h, {
				id: "infra-pods-search",
				value: searchText,
				onInput: (value) => Message.ChangedQuery({ value }),
				onClear: Message.ChangedQuery({ value: "" }),
				placeholder: "Search all pods…",
				trailing:
					offset > 0 ? pageRangeLabel(offset, pods.length, page.totalCount, "pods") : countLabel(pods.length, page.totalCount, "pod"),
			}),
			activeFilterChips(h, {
				className: "mb-0",
				chips: facetChips(FACETS, (param) => model.search[param]).map((chip) => ({
					id: chip.param,
					label: chip.label,
					values: chip.values,
					isNegated: chip.isNegated,
					onRemove: Message.RemovedFilterChip({ param: chip.param }),
				})),
			}),
			pods.length === 0
				? filteredEmpty(h, {
						noun: "pods",
						className: "py-12",
						icon: icon(h, "MagnifierIcon", { size: 16 }),
						description:
							scope === undefined
								? "Try a different name, or clear the filters to see the whole fleet."
								: `Nothing is ${SCOPE_LABEL.get(scope) ?? ""} in this window, which is good news.`,
						onClear: Message.ClickedClearFilters(),
						clearLabel: "Clear all filters",
					})
				: podTable(h, pods, {
						sortBy,
						sortDir,
						onSort: (key) => Message.ClickedSort({ key }),
						activeKey: model.search.peek,
						canPeek: true,
						timeSearch: pickTimeSearch(model.search),
						isWaiting,
						referenceTime: model.frame.window?.endTime ?? "",
						nowMs: model.frame.nowMs,
						timeZone: inputs.context.timeZone,
						restarts: AsyncData.getData(AsyncData.map(model.restarts.data, summarizePodRestarts)),
					}),
			offsetPager(h, {
				offset,
				shown: pods.length,
				total: page.totalCount,
				pageSize: PAGE_SIZE,
				noun: "pods",
				onPage: (direction) => Message.ClickedPage({ direction }),
			}),
		],
	)
}

const podsArea = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.pods.data, {
		onEmpty: () => podTableLoading(h),
		onFailure: (failure) => errorState(h, { failure, title: "Failed to load pods", onRetry: Message.ClickedRetryPods() }),
		onData: (page) => listArea(h, model, page, inputs),
	})

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents")],
		[
			dashboardPage(
				h,
				{
					actions: Frame.controls(h, model.frame, { search: model.search, defaultPreset: DEFAULT_PRESET }, toFrame),
					tabs: kubernetesViewTabs(h, "pods", model.search),
					filters: filtersRail(h, model),
				},
				[h.div([h.Class("space-y-5")], [summaryBand(h, model), podsArea(h, model, inputs)])],
			),
			h.submodel({
				slotId: "pod-peek",
				model: model.peek,
				view: PeekView.view,
				viewInputs: {
					peek: peekOf(model),
					referenceTime: model.frame.window?.endTime ?? "",
					nowMs: model.frame.nowMs,
					timeZone: inputs.context.timeZone,
					timeSearch: pickTimeSearch(model.search),
					locale: model.frame.locale,
				},
				toParentMessage: (message) => Message.GotPeekMessage({ message }),
			}),
		],
	),
)