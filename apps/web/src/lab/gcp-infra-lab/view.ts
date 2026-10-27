import { INITIAL_LOCALE } from "../../page/kit/locale"
import {
	BUCKET_SECONDS,
	CLOUD_SQL_INSTANCES,
	END,
	FLEET,
	PROJECT_HEALTH,
	SPARKLINE_READS,
	START,
	VIEW_LABEL,
	VIEWS,
} from "../gcp-infra-fixture"
import { gcpRequestedView, gcpSparks, gcpWindowSeconds } from "../../components/infra/gcp/list-model"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../charts/theme-colors"
import * as GcpList from "../../page/infra-integrations/gcp/list/model"
import { viewHref } from "../../page/infra-integrations/gcp/list/update"
import { gcpListPageParts, THEME_TOKENS, titleRow } from "../../page/infra-integrations/gcp/list/view"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { segmentedSelect } from "../../ui/segmented-select"
import { Message, type Model } from "./model"

const SPARKS = gcpSparks(SPARKLINE_READS, { startTime: START, endTime: END, bucketSeconds: BUCKET_SECONDS })

const TIME_SEARCH = { startTime: START, endTime: END }

/** The page as the route mounts it: the shared title row and view tabs over the fixtures. */
const listView = Submodel.defineView<Model, GcpList.Message>((model, h) => {
	const page = gcpListPageParts(h, {
		fleet: FLEET,
		sparks: SPARKS,
		windowSeconds: gcpWindowSeconds(START, END),
		cloudSqlInstances: CLOUD_SQL_INSTANCES,
		projectHealth: PROJECT_HEALTH,
		collecting: false,
		notice: [],
		resources: () => h.empty,
		state: { ...model.state, view: gcpRequestedView(model.state.view, undefined) },
		timeSearch: TIME_SEARCH,
		theme: model.themeColors,
		isChartReady: model.chartRuntime._tag !== "Loading",
		isWaiting: false,
		projectMenu: model.projectMenu,
		locale: INITIAL_LOCALE,
		// The lab holds its state in the model, so a plain click switches in place.
		viewTab: (view) => ({
			href: viewHref({}, view),
			onClick: GcpList.Message.ClickedView({ view }),
		}),
	})
	// The header shows the fixture's 12h span as a preset, as the route's default does.
	const time = {
		search: { timePreset: "12h" },
		window: TIME_SEARCH,
		timePicker: model.timePicker,
		isReloading: model.isReloading,
	}
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					scrollClassName: "gap-6",
					...titleRow(h, page.header, time, page.isFailed),
					tabs: page.tabs,
				},
				page.body,
			),
		],
	)
})

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "gcp-list",
		model,
		view: listView,
		toParentMessage: (message) => Message.GotListMessage({ message }),
	})

/** The floating lab bar: which view the list opens on. */
export const overlay = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.Class(
				"fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-popover px-3 py-2 shadow-lg",
			),
		],
		[
			h.span([h.Class("font-mono text-2xs text-muted-foreground")], ["Google Cloud lab"]),
			segmentedSelect(h, {
				size: "xs",
				ariaLabel: "Lab view",
				options: VIEWS.map((value) => ({ value, label: VIEW_LABEL[value] })),
				value: VIEWS.find((view) => view === model.state.view) ?? "services",
				onChange: (view) => Message.ClickedLabView({ view }),
			}),
		],
	)
