import { refreshingClass } from "@maple/ui/lib/refreshing"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "../../../../ui/error-state"
import { activeFilterChips } from "../../../../ui/filters/active-filter-chips"
import { icon } from "../../../../ui/icon"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { facetChips } from "../../kit/facets"
import { FLEET_BAND_BOXED, fleetBand, fleetBandLoading } from "../../kit/fleet-band"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import * as InstallModalView from "../../kit/install-modal-view"
import { offsetPager, pageRangeLabel } from "../../kit/offset-pager"
import { countLabel, searchToolbar, setupEmpty } from "../../kit/page-parts"
import { filteredEmpty } from "../../../kit/signal-empty-state"
import { hostsViewTabs } from "../../kit/view-tabs"
import { PAGE_SIZE } from "./command"
import { type ContainerScope, type FilterParam, Message } from "./message"
import type { ContainerCounts, ContainersPage, Model } from "./model"
import { DEFAULT_PRESET, filtersOf, pageIndexOf, sortOf } from "./update"
import { filtersRail } from "./view-filters"
import { containerTable, containerTableLoading } from "./view-table"

// `ContainersPage`.

type H = HtmlBuilder<Message>

const FACETS: ReadonlyArray<Readonly<{ label: string; include: FilterParam; exclude: FilterParam }>> = [
	{ label: "Container", include: "containerNames", exclude: "excludedContainerNames" },
	{ label: "Image", include: "images", exclude: "excludedImages" },
	{ label: "Host", include: "hostNames", exclude: "excludedHostNames" },
	{ label: "Compose project", include: "composeProjects", exclude: "excludedComposeProjects" },
	{ label: "Compose service", include: "composeServices", exclude: "excludedComposeServices" },
	{ label: "Environment", include: "environments", exclude: "excludedEnvironments" },
]

const SCOPE_LABEL = new Map<ContainerScope, string>([
	["saturated", "at or above 90% of CPU or its memory limit"],
	["elevated", "at or above 60% of CPU or its memory limit"],
	["stale", "whose agent has gone quiet"],
])

const summaryBand = (h: H, model: Model): Html =>
	AsyncData.matchData(model.summary.data, {
		onEmpty: () => fleetBandLoading(h, 3, FLEET_BAND_BOXED),
		onFailure: () => null,
		onData: (counts: ContainerCounts) => {
			const healthy = Math.max(
				counts.totalContainers - counts.saturatedContainers - counts.elevatedContainers,
				0,
			)
			return fleetBand(h, {
				total: counts.totalContainers,
				noun: "container",
				caption: "share of the fleet by peak utilization",
				segments: [
					{ key: "healthy", count: healthy, className: TONE_FILL.ok },
					{ key: "elevated", count: counts.elevatedContainers, className: TONE_FILL.warn },
					{ key: "saturated", count: counts.saturatedContainers, className: TONE_FILL.crit },
				],
				cells: [
					{
						scope: "saturated",
						label: "Saturated",
						hint: "≥90%",
						value: counts.saturatedContainers,
						tone: "crit",
					},
					{
						scope: "elevated",
						label: "Elevated",
						hint: "≥60%",
						value: counts.elevatedContainers,
						tone: "warn",
					},
					{
						scope: "stale",
						label: "Stale agent",
						hint: ">5m",
						value: counts.staleContainers,
						tone: "neutral",
					},
				],
				activeScope: model.search.scope,
				onScopeChange: (scope) => Message.ChangedScope({ scope }),
				isWaiting: AsyncData.isRefreshing(model.summary.data),
				className: FLEET_BAND_BOXED,
			})
		},
	})

const toInstall = (message: InstallModal.Message) => Message.GotInstallMessage({ message })

const tableArea = (h: H, model: Model, page: ContainersPage, inputs: PageViewInputs): Html => {
	const isWaiting = AsyncData.isRefreshing(model.containers.data)
	const searchText = model.search.q ?? ""
	const scope = model.search.scope
	const offset = pageIndexOf(model) * PAGE_SIZE
	const hasStructuredFilter = Object.values(filtersOf(model.search)).some(
		(values) => (values?.length ?? 0) > 0,
	)
	const hasAnyNarrowing =
		hasStructuredFilter || searchText.trim() !== "" || scope !== undefined || offset > 0
	const containers = page.data
	if (containers.length === 0 && !hasAnyNarrowing)
		return setupEmpty(h, {
			icon: icon(h, "DockerIcon", { size: 16 }),
			title: "No containers reporting yet",
			description:
				"Run the Maple Docker agent next to your containers to collect per-container CPU, memory, network, and block I/O. On Kubernetes, the Helm chart collects container metrics too.",
			actionLabel: "Install the Docker agent",
			onAction: toInstall(InstallModal.Message.ClickedOpen()),
			docs: "docker",
			modal: h.submodel({
				slotId: "install-modal",
				model: model.install,
				view: InstallModalView.mountedView,
				toParentMessage: toInstall,
			}),
		})
	const { sortBy, sortDir } = sortOf(model.search)
	return h.div(
		[h.Class(cn("space-y-4", refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			searchToolbar(h, {
				id: "infra-containers-search",
				value: searchText,
				onInput: (value) => Message.ChangedQuery({ value }),
				onClear: Message.ChangedQuery({ value: "" }),
				placeholder: "Search all containers…",
				trailing:
					offset > 0
						? pageRangeLabel(offset, containers.length, page.totalCount, "containers")
						: countLabel(containers.length, page.totalCount, "container"),
			}),
			containers.length === 0
				? filteredEmpty(h, {
						noun: "containers",
						icon: icon(h, "MagnifierIcon", { size: 16 }),
						description:
							scope === undefined
								? "Try a different name, or clear the filters to see the whole fleet."
								: `Nothing is ${SCOPE_LABEL.get(scope) ?? ""} in this window, which is good news.`,
						onClear: Message.ClickedClearFilters(),
						clearLabel: "Clear all filters",
						className: "py-12",
					})
				: containerTable(h, containers, {
						sortBy,
						sortDir,
						isWaiting,
						referenceTime: model.frame.window?.endTime ?? "",
						nowMs: model.frame.nowMs,
						timeZone: inputs.context.timeZone,
					}),
			offsetPager(h, {
				offset,
				shown: containers.length,
				total: page.totalCount,
				pageSize: PAGE_SIZE,
				noun: "containers",
				onPage: (direction) => Message.ClickedPage({ direction }),
			}),
		],
	)
}

const containersArea = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.containers.data, {
		onEmpty: () => containerTableLoading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load containers",
				onRetry: Message.ClickedRetryContainers(),
			}),
		onData: (page) => tableArea(h, model, page, inputs),
	})

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents")],
		[
			dashboardPage(
				h,
				{
					title: "Containers",
					description: "Sorted worst-first by peak utilization against each container's own limits.",
					actions: Frame.controls(
						h,
						model.frame,
						{ search: model.search, defaultPreset: DEFAULT_PRESET },
						toFrame,
						AsyncData.isFailure(model.containers.data),
					),
					tabs: hostsViewTabs(h, "containers", model.search),
					filters: filtersRail(h, model),
					gap: "lg",
				},
				[
					activeFilterChips(h, {
						chips: facetChips(FACETS, (param) => model.search[param]).map((chip) => ({
							id: chip.param,
							label: chip.label,
							values: chip.values,
							isNegated: chip.isNegated,
							onRemove: Message.RemovedFilterChip({ param: chip.param }),
						})),
					}),
					summaryBand(h, model),
					containersArea(h, model, inputs),
				],
			),
		],
	),
)
