import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import { encodeLogKey } from "../../../lib/log-key"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { copyButton } from "../../../ui/copy-button"
import { icon } from "../../../ui/icon"
import type { LogRecord } from "../../../ui/logs/log-row-view"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { buildLogJsonPayload } from "./derive"
import { Message, type Model } from "./model"
import { copyStatusOf } from "./update"
import { copyable } from "./view-hero"

// The log's meta strip, as the drawer shows it.

type H = HtmlBuilder<Message>

const tooltipTrigger = (h: H, id: string) => [
	h.DataAttribute("base-ui-tooltip-trigger", ""),
	h.DataAttribute("slot", "tooltip-trigger"),
	h.Id(id),
]

export const metaStrip = (
	h: H,
	model: Model,
	log: LogRecord,
	timeZone: string,
	showOpenFullPage = true,
): Html =>
	h.div(
		[
			h.Class(
				"flex items-center gap-2 overflow-x-auto border-b px-4 py-1.5 text-xs shrink-0 whitespace-nowrap",
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-1.5 shrink-0")],
				[
					icon(h, "ClockIcon", { size: 12, className: "text-muted-foreground" }),
					h.span(
						[h.Class("font-mono")],
						[
							copyable(h, model, "meta-time", log.timestamp, [
								formatTimestampInTimezone(log.timestamp, { timeZone, withMilliseconds: true }),
							]),
						],
					),
				],
			),
			...(log.traceId
				? [
						h.a(
							[
								h.Class(
									"inline-flex shrink-0 items-center gap-1 rounded-sm border border-primary-a3 bg-primary-a1 px-1.5 py-0.5 font-mono text-2xs text-primary hover:bg-primary-a2 active:bg-primary-a2",
								),
								h.Href(
									hrefOf(
										AppRoute.Trace({
											traceId: log.traceId,
											search: { t: log.timestamp },
										}),
									),
								),
								h.Title(`View trace ${log.traceId}`),
							],
							[icon(h, "PulseIcon", { size: 12 }), "trace:", shortId(log.traceId, "trace")],
						),
					]
				: []),
			...(log.spanId
				? [
						h.span(
							[h.Class("shrink-0 font-mono text-2xs text-muted-foreground")],
							[
								copyable(h, model, "meta-span", log.spanId, [
									"span:",
									shortId(log.spanId, "span"),
								]),
							],
						),
					]
				: []),
			h.div(
				[h.Class("ml-auto flex shrink-0 items-center gap-0.5")],
				[
					...(showOpenFullPage
						? [
								h.a(
									[
										h.AriaLabel("Open in full page"),
										h.Class(
											cn(
												buttonVariants({
													size: "icon-xs",
													variant: "ghost",
													className: "text-muted-foreground",
												}),
											),
										),
										h.DataAttribute("base-ui-tooltip-trigger", ""),
										h.DataAttribute("slot", "icon-button"),
										h.Href(`/logs/${encodeLogKey(log)}`),
										h.Id("log-detail-open-full-page"),
									],
									[icon(h, "ExternalLinkIcon")],
								),
							]
						: []),
					copyButton(h, {
						status: copyStatusOf(model, "meta-link"),
						label: "Link to log",
						idleIcon: "LinkIcon",
						iconSize: 13,
						onClick: Message.ClickedCopyPermalink({
							copyId: "meta-link",
							logKey: encodeLogKey(log),
						}),
						attributes: tooltipTrigger(h, "log-detail-copy-link"),
					}),
					copyButton(h, {
						status: copyStatusOf(model, "meta-json"),
						label: "Log JSON",
						iconSize: 13,
						onClick: Message.ClickedCopy({ copyId: "meta-json", text: buildLogJsonPayload(log) }),
						attributes: tooltipTrigger(h, "log-detail-copy-json"),
					}),
				],
			),
		],
	)
