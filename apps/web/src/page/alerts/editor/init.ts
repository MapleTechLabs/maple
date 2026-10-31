import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import type { AppRoute } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import * as Tooltip from "../../../ui/tooltip"
import type { PageContext, PageReturn } from "../../contract"
import * as QueryPanel from "../../kit/query-builder/panel"
import * as TimeRangePicker from "../../kit/time-range-picker"
import * as DestinationDialog from "../destination/dialog"
import * as ChatConnect from "../shared/chat-connect"
import { FetchEditorConnectors, GenerateDraftId, ReadEditorClock, ReadEditorIsAdmin } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type CreateRoute = Extract<AppRoute, { readonly _tag: "AlertsCreate" }>

/** Preview lookback the form opens on: a week shows how often the rule would really fire. */
export const DEFAULT_PREVIEW_PRESET = "7d"

export const init = (route: CreateRoute, _context: PageContext): PageReturn<Model, Message> => ({
	model: {
		search: route.search,
		status: "Loading",
		draftKey: null,
		form: null,
		savedForm: null,
		editingRuleId: null,
		mountedForm: null,
		notices: [],
		draftId: null,
		rules: null,
		states: null,
		incidents: null,
		destinations: null,
		isRulesLoadFailed: false,
		sourceDashboards: null,
		isDashboardsLoadFailed: false,
		isAdmin: false,
		isDefaultDestinationApplied: false,
		connectors: null,
		autocompleteWindow: null,
		previewPreset: DEFAULT_PREVIEW_PRESET,
		previewWindow: null,
		traceFacets: Keyed.idle(),
		autocomplete: {},
		preview: Keyed.idle(),
		savedPreview: Keyed.idle(),
		dryRun: null,
		isDryRunning: false,
		isSendingTest: false,
		isSaving: false,
		kindNotice: null,
		isNotesOpen: false,
		tagSuggestions: [],
		isSqlCollapsed: false,
		isMessageTemplateOpen: false,
		tagDraft: "",
		templates: Dialog.init("alert-rule-templates", "dialog"),
		queryPanels: QueryPanel.init("alert-rule"),
		selects: {},
		combos: {},
		menus: {},
		destinationDialog: DestinationDialog.init("alert-rule-destination"),
		issuesTooltip: Tooltip.init("alert-rule-issues"),
		chatConnect: ChatConnect.init(),
		chatConnectMenuId: null,
		brokenLogos: [],
		timePicker: TimeRangePicker.init("alert-rule-preview-range"),
		chart: Chart.init(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
	},
	commands: [
		GenerateDraftId(),
		ReadEditorClock(),
		ReadEditorIsAdmin(),
		FetchEditorConnectors(),
		Command.mapMessage(LoadChartRuntime(), (message) =>
			message._tag === "CompletedLoadChartRuntime"
				? Message.CompletedLoadChartRuntime()
				: Message.FailedLoadChartRuntime({ reason: message.reason }),
		),
	],
})
