import { getSeverityColor } from "@maple/ui/lib/severity"
import { stripAnsi } from "@maple/ui/components/logs/strip-ansi"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as AttributesPanel from "../attributes/attributes-panel"
import { capForDisplay, prettyJson } from "../../lib/display-text"
import * as AttributesView from "../attributes/attributes-view"
import { copyButton, type CopyStatus } from "../copy-button"
import { icon } from "../icon"
import { highlightedText } from "./highlight"
import { truncationNote } from "./log-message"
import type { LogRecord } from "./log-row-view"

// An expanded log row: the full body on a
// severity-coloured edge, Details and JSON actions, then every attribute.

/** The log as the Raw panel and the JSON copy show it. */
export const buildLogJsonPayload = (log: LogRecord): string =>
	JSON.stringify(
		{
			timestamp: log.timestamp,
			severityText: log.severityText,
			severityNumber: log.severityNumber,
			serviceName: log.serviceName,
			body: log.body,
			traceId: log.traceId || undefined,
			spanId: log.spanId || undefined,
			logAttributes: log.logAttributes,
			resourceAttributes: log.resourceAttributes,
		},
		null,
		2,
	)

/** Stack frames (`at …`, `File "…"`) read as context under the message line. */
const FRAME = /^\s+(at |File "|from )/

const stop = { propagation: "Stop" } as const

export type ExpandedEvents<Message> = Readonly<{
	clickedDetails: Message
	clickedCopyJson: Message
	toPanelMessage: (message: AttributesPanel.Message) => Message
}>

export const logRowExpanded = <Message>(
	h: HtmlBuilder<Message>,
	log: LogRecord,
	highlight: string | undefined,
	panel: AttributesPanel.Model,
	jsonStatus: CopyStatus,
	canFilter: boolean,
	events: ExpandedEvents<Message>,
): Html => {
	const body = stripAnsi(log.body)
	const formatted = Option.getOrElse(prettyJson(body), () => body)
	const { shown, omitted } = capForDisplay(formatted)
	const lines = shown.split("\n")
	return h.div(
		[h.Class("border-t border-border/60 bg-muted/20 px-3 py-3 pl-9 font-mono")],
		[
			h.div(
				[h.Class("max-h-[60vh] space-y-3 overflow-auto")],
				[
					h.div(
						[
							h.Class(
								"relative rounded-md border border-border/60 bg-background/60 py-2 pl-3 pr-24",
							),
						],
						[
							h.span([
								h.AriaHidden(true),
								h.Class("absolute inset-y-1.5 left-0 w-0.5 rounded-full"),
								h.Style({ "background-color": getSeverityColor(log.severityText) }),
							]),
							h.div(
								[h.Class("absolute right-1.5 top-1.5 flex items-center gap-2")],
								[
									h.button(
										[
											h.Type("button"),
											h.Class(
												"flex cursor-pointer items-center gap-1 text-3xs text-muted-foreground transition-colors hover:text-foreground",
											),
											h.OnClick(events.clickedDetails, stop),
										],
										[icon(h, "ExternalLinkIcon", { size: 10 }), "Details"],
									),
									copyButton(h, {
										status: jsonStatus,
										label: "Log JSON",
										idleLabel: "JSON",
										iconSize: 10,
										className: "h-5 px-1.5 text-3xs",
										attributes: [h.OnClick(events.clickedCopyJson, stop)],
									}),
								],
							),
							h.pre(
								[
									h.Class(
										"whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground",
									),
								],
								lines.map((line, index) =>
									h.span(FRAME.test(line) ? [h.Class("text-muted-foreground")] : [], [
										...highlightedText(h, line, highlight),
										...(index < lines.length - 1 ? ["\n"] : []),
									]),
								),
							),
							...(omitted === 0 ? [] : [truncationNote(h, shown.length, formatted.length)]),
						],
					),
					h.submodel({
						slotId: `${panel.id}-slot`,
						model: panel,
						view: AttributesView.view,
						viewInputs: {
							logAttributes: log.logAttributes,
							resourceAttributes: log.resourceAttributes,
							canFilter,
						},
						toParentMessage: events.toPanelMessage,
					}),
				],
			),
		],
	)
}
