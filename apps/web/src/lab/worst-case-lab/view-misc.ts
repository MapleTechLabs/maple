import { attributes } from "../worst-case-fixture"
import { Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import type { Message as HubMessage } from "../../page/alerts/hub/message"
import type { Model as HubModel } from "../../page/alerts/hub/model"
import { alertsEmptyState } from "../../page/alerts/hub/view-empty"
import { rulesTab } from "../../page/alerts/hub/view-rules"
import { toolStandalone } from "../../page/chat/kit/view-tool"
import type { ToolPart } from "../../page/chat/kit/ui-message"
import type * as AttributesPanel from "../../ui/attributes/attributes-panel"
import { tableView as attributesTableView } from "../../ui/attributes/attributes-view"
import { listFooterText } from "../../ui/logs/viewer"
import type * as LogsStream from "../../ui/logs/logs-stream"
import * as LogsStreamView from "../../ui/logs/logs-stream-view"
import { severityBadge } from "../../ui/logs/severity-badge"
import { PINNED_COLUMNS, rulesOverview } from "./fixture"
import { Message, type Model } from "./model"
import { type H, narrow, wcSection } from "./view-parts"
import { releaseNarrow } from "./view-sections"

// `TablesSection` and `MiscSection`.

type RulesInputs = Readonly<{ mode: Model["mode"]; nowMs: number }>

/** `RulesTab` reads the hub's Model (search, show-all, menus); `status` stays unset. */
const rulesView = Submodel.defineView<HubModel, HubMessage, RulesInputs>((hub, inputs, h) =>
	rulesTab(h, hub, {
		data: rulesOverview(inputs.mode, inputs.nowMs),
		destinations: [],
		status: undefined,
		emptyState: alertsEmptyState(h, {
			isAdmin: true,
			hasDestinations: false,
			serviceName: undefined,
			onAddDestination: undefined,
		}),
	}),
)

export const tablesSection = (h: H, model: Model): Html =>
	wcSection(h, "wc-tables", "Tables: alert rules, release comparison", [
		h.submodel({
			slotId: "wc-rules",
			model: model.hub,
			view: rulesView,
			viewInputs: { mode: model.mode, nowMs: model.nowMs },
			toParentMessage: (message: HubMessage) => Message.GotRulesMessage({ message }),
		}),
		releaseNarrow(h, model),
	])

/** The two `<Tool>`s: a settled call with its argument and result, and a live one. */
const toolParts = (toolName: string, service: string): ReadonlyArray<ToolPart> => [
	{
		_tag: "dynamic-tool",
		toolCallId: "wc-tool-1",
		toolName,
		state: "output-available",
		input: { service },
		output: "ok",
	},
	{ _tag: "dynamic-tool", toolCallId: "wc-tool-2", toolName, state: "input-available", input: {} },
]

const LONG_TOOL = "mcp__maple__query_traces_by_service_and_time_window"

export const miscSection = (h: H, model: Model): Html => {
	const isDemo = model.mode === "demo"
	const severities = isDemo ? ["INFO", "ERROR"] : ["", "TRACE2", "EMERGENCY_UNRECOVERABLE"]
	const toolName = isDemo ? "query_traces" : LONG_TOOL
	const service = isDemo ? "api" : "checkout-service-payments-reconciliation-worker-eu-west-1"
	const host = {
		isOpen: (id: string) => model.openTools.includes(id),
		onToggle: (id: string) => Message.ToggledTool({ id }),
	}
	return wcSection(h, "wc-misc", "Misc: severity, log body, attributes, tool header", [
		h.div(
			[h.Class("flex items-center gap-2")],
			severities.map((severity) => severityBadge(h, { severity })),
		),
		h.div(
			[h.Class("flex h-[260px] flex-col rounded-md border")],
			[
				h.submodel({
					slotId: "wc-logs",
					model: model.logs,
					view: LogsStreamView.view,
					viewInputs: {
						wrap: false,
						density: "compact",
						pinnedColumns: PINNED_COLUMNS,
						searchText: undefined,
						timeZone: model.timeZone,
						isWaiting: false,
						footerText: listFooterText("en-US", {
							shown: model.logs.rows.length,
							noun: "logs",
							capped: false,
							hasMore: false,
						}),
						canFilter: false,
					},
					toParentMessage: (message: LogsStream.Message) => Message.GotLogsMessage({ message }),
				}),
			],
		),
		narrow(h, [
			h.submodel({
				slotId: "wc-attributes",
				model: model.attributes,
				view: attributesTableView,
				viewInputs: { attributes: attributes(model.mode), title: "Span attributes" },
				toParentMessage: (message: AttributesPanel.Message) =>
					Message.GotAttributesMessage({ message }),
			}),
		]),
		narrow(
			h,
			toolParts(toolName, service).map((part) => toolStandalone(h, part, host)),
		),
	])
}
