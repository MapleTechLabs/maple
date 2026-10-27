import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "../../../ui/error-state"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { presenceOf } from "../../kit/signal-presence"
import { signalEmptyState } from "../../kit/signal-empty-state"
import { detectLookup } from "../kit/detected-models"
import { agentSessionsTabs } from "../kit/tabs"
import { MountReachEnd, MountRowClicks, MountTable, VirtualizeSessions } from "./command"
import {
	displayedRows,
	filterInputs,
	filterKeyOf,
	hasFilters,
	hasNextPage,
	MAX_RETAINED_SESSIONS,
	sortOf,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { filtersRail } from "./view-filters"
import { listSkeleton, sessionsTable } from "./view-table"
import { toolbar } from "./view-toolbar"

type H = HtmlBuilder<Message>

const listArea = (h: H, model: Model, inputs: PageViewInputs): Html => {
	const { window } = model
	return AsyncData.matchData(model.firstPage.data, {
		onEmpty: () => listSkeleton(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load agent sessions",
				onRetry: Message.ClickedReload(),
			}),
		onData: () => {
			const filterKey = window === null ? "" : filterKeyOf(filterInputs(model.search, window))
			const rows = displayedRows(model, filterKey)
			if (rows.length === 0) {
				return h.div(
					[h.Class("contents")],
					[
						signalEmptyState(h, {
							signal: "traces",
							presence: presenceOf(model.presence, "traces"),
							nowMs: model.nowMs,
							noun: "agent sessions",
							purpose:
								"Replay each AI agent conversation, with its LLM and tool calls in order.",
							guideDocs: "agentSessions",
							setupDocs: "agentSessions",
							isFiltered: hasFilters(model.search),
							onClearFilters: Message.ClickedClearFilters(),
						}),
					],
				)
			}
			return sessionsTable(h, {
				rows,
				sort: sortOf(model.search),
				context: {
					nowMs: model.nowMs,
					timeZone: inputs.context.timeZone,
					detect: detectLookup(model.detections),
				},
				hasMore: hasNextPage(model, filterKey),
				isLoadingMore: model.isFetchingNextPage,
				isCapped: rows.length >= MAX_RETAINED_SESSIONS,
				onPainted: h.OnMount(MountTable()),
				onReachEnd: h.OnMount(MountReachEnd()),
				onRowClick: h.OnMount(MountRowClicks()),
				virtual: { window: model.listWindow, mount: h.OnMount(VirtualizeSessions()) },
			})
		},
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const firstPage = model.firstPage.data
	const window = model.window
	const filterKey = window === null ? "" : filterKeyOf(filterInputs(model.search, window))
	const tabSessions = Option.getOrUndefined(AsyncData.getData(model.tabSessions.data))
	return dashboardPage(
		h,
		{
			title: "Agent Sessions",
			filters: filtersRail(h, model),
			tabs: agentSessionsTabs(h, {
				active: "sessions",
				counts: {
					sessions: tabSessions,
					tools: Option.getOrUndefined(AsyncData.getData(model.tabTools.data)),
				},
				className: "border-b border-border",
			}),
			sticky: toolbar(h, model, {
				sessionCount: AsyncData.hasData(firstPage)
					? displayedRows(model, filterKey).length
					: undefined,
				totalCount: tabSessions,
				isWaiting: AsyncData.isPending(firstPage) || AsyncData.isIdle(firstPage),
				isFailed: AsyncData.isFailure(firstPage),
			}),
			scrollClassName: "pt-0",
		},
		[listArea(h, model, inputs)],
	)
})
