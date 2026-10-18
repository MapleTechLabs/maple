import { formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { FLEET_BAND_BOXED, fleetBand, fleetBandLoading } from "../../kit/fleet-band"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import * as InstallModalView from "../../kit/install-modal-view"
import { countLabel, pageHero, searchToolbar, setupEmpty } from "../../kit/page-parts"
import { filteredEmpty } from "../../../kit/signal-empty-state"
import { type SortAccessors, sortRowsBy } from "../../../kit/table-sort"
import { hostsViewTabs } from "../../kit/view-tabs"
import { HOST_LIST_LIMIT } from "./command"
import { countHostScopes, filterHosts } from "./derive"
import { Message } from "./message"
import type { HostRow, Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { hostTable, hostTableLoading } from "./view-table"

// `HostsPage` / `HostList` (apps/web/src/routes/infra/hosts/index.tsx).

type H = HtmlBuilder<Message>

/** `HostRow` columns `useTableSort` reads by key. */
export const HOST_SORT_ACCESSORS: SortAccessors<HostRow> = new Map<string, (row: HostRow) => string | number>([
	["cpuPct", (row) => row.cpuPct],
	["hostName", (row) => row.hostName],
	["load15", (row) => row.load15],
	["lastSeen", (row) => row.lastSeen],
])

const openInstall = Message.GotInstallMessage({ message: InstallModal.Message.ClickedOpen() })

const hostList = (
	h: H,
	model: Model,
	hosts: ReadonlyArray<HostRow>,
	isWaiting: boolean,
	inputs: PageViewInputs,
): Html => {
	const referenceTime = model.frame.window?.endTime ?? ""
	const scope = model.search.scope
	const filtered = filterHosts(hosts, scope, model.search.q ?? "", referenceTime)
	const counts = countHostScopes(hosts, referenceTime)
	const healthy = Math.max(counts.total - counts.saturated - counts.elevated, 0)
	const trailing =
		hosts.length >= HOST_LIST_LIMIT
			? `${formatNumber(filtered.length)} of the ${formatNumber(HOST_LIST_LIMIT)} most recently seen hosts`
			: filtered.length === hosts.length
				? countLabel(hosts.length, hosts.length, "host")
				: `${formatNumber(filtered.length)} of ${formatNumber(hosts.length)} hosts`
	return h.div(
		[h.Class(cn("space-y-4", refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			fleetBand(h, {
				total: counts.total,
				noun: "host",
				caption: "share of the fleet by its busiest of CPU, memory and disk",
				segments: [
					{ key: "healthy", count: healthy, className: TONE_FILL.ok },
					{ key: "elevated", count: counts.elevated, className: TONE_FILL.warn },
					{ key: "saturated", count: counts.saturated, className: TONE_FILL.crit },
				],
				cells: [
					{
						scope: "saturated",
						label: "Saturated",
						hint: "≥90%",
						value: counts.saturated,
						tone: "crit",
					},
					{
						scope: "elevated",
						label: "Elevated",
						hint: "≥60%",
						value: counts.elevated,
						tone: "warn",
					},
					{
						scope: "stale",
						label: "Stopped reporting",
						hint: ">5m",
						value: counts.stale,
						tone: "neutral",
					},
				],
				activeScope: scope,
				onScopeChange: (next) => Message.ChangedScope({ scope: next }),
				className: FLEET_BAND_BOXED,
			}),
			searchToolbar(h, {
				id: "infra-hosts-search",
				value: model.search.q ?? "",
				onInput: (value) => Message.ChangedQuery({ value }),
				onClear: Message.ChangedQuery({ value: "" }),
				placeholder: "Search hosts…",
				trailing,
			}),
			filtered.length === 0
				? filteredEmpty(h, {
						noun: "hosts",
						className: "py-12",
						icon: icon(h, "MagnifierIcon", { size: 16 }),
						title: "No hosts match",
						description: "Try a different name, or clear the search and scope to see every host.",
						onClear: Message.ClickedClearSearch(),
						clearLabel: "Clear",
					})
				: hostTable(h, sortRowsBy(filtered, model.sort, HOST_SORT_ACCESSORS), {
						nowMs: model.frame.nowMs,
						timeZone: inputs.context.timeZone,
						isWaiting,
						sort: model.sort,
						onSort: (key) => Message.ClickedSort({ key }),
					}),
		],
	)
}

const body = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.hosts.data, {
		onEmpty: () => loading(h),
		onFailure: (failure) => errorState(h, { failure }),
		onData: (hosts) => listOrEmpty(h, model, hosts, AsyncData.isRefreshing(model.hosts.data), inputs),
	})

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents")],
		[
			dashboardPage(
				h,
				{
					actions: Frame.controls(
						h,
						model.frame,
						{ search: model.search, defaultPreset: DEFAULT_PRESET },
						toFrame,
					),
					tabs: hostsViewTabs(h, "hosts", model.search),
					scrollClassName: "gap-6",
				},
				[
					pageHero(h, {
						title: "Hosts",
						description:
							"Every machine sending CPU, memory, disk and network metrics, busiest first.",
						actions: [
							button(
								h,
								{ size: "sm", variant: "outline", attributes: [h.OnClick(openInstall)] },
								[icon(h, "PlusIcon"), "Add host"],
							),
						],
					}),
					body(h, model, inputs),
					h.submodel({
						slotId: "install-modal",
						model: model.install,
						view: InstallModalView.view,
						toParentMessage: (message) => Message.GotInstallMessage({ message }),
					}),
				],
			),
		],
	),
)

const loading = (h: H): Html =>
	h.div([h.Class("space-y-6")], [fleetBandLoading(h, 3, FLEET_BAND_BOXED), hostTableLoading(h)])

const listOrEmpty = (
	h: H,
	model: Model,
	hosts: ReadonlyArray<HostRow>,
	isWaiting: boolean,
	inputs: PageViewInputs,
) =>
	hosts.length === 0
		? setupEmpty(h, {
				icon: icon(h, "ServerIcon", { size: 16 }),
				title: "No hosts reporting yet",
				description:
					"Run the OpenTelemetry Collector with the hostmetrics receiver on a host, or install the Helm chart to report every Kubernetes node.",
				actionLabel: "Add host",
				onAction: openInstall,
				docs: "hosts",
			})
		: hostList(h, model, hosts, isWaiting, inputs)
