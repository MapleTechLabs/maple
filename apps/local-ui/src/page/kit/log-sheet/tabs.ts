import { highlightJson } from "../../../lib/highlight"
import * as AttributesView from "@maple/web/ui/attributes/attributes-view"
import { linkButton } from "@maple/web/ui/button"
import * as CopyButton from "@maple/web/ui/copy-button"
import { icon, type IconName } from "@maple/web/ui/icon"
import { keyValue, keyValueList } from "@maple/web/ui/key-value"
import { scrollArea } from "@maple/web/ui/scroll-area"
import * as TabsView from "@maple/web/ui/tabs-view"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { copyOf } from "../copies"
import { Message } from "./message"
import type { LocalLog, Model } from "./model"
import { buildLogJsonPayload, copyableValue, traceHrefOf } from "./parts"

// The Attributes / Trace / Raw tabs of `LogDetailSheet`.

const TABS: ReadonlyMap<string, Readonly<{ label: string; icon: IconName }>> = new Map([
	["attributes", { label: "Attributes", icon: "CircleInfoIcon" }],
	["trace", { label: "Trace", icon: "PulseIcon" }],
	["raw", { label: "Raw", icon: "CodeIcon" }],
] as const)

const padded = (h: HtmlBuilder<Message>, id: string, children: ReadonlyArray<Html>): ReadonlyArray<Html> => [
	scrollArea(h, { className: "h-full", idPrefix: id }, [h.div([h.Class("p-3")], children)]),
]

const tracePanel = (h: HtmlBuilder<Message>, model: Model, log: LocalLog, href: string): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			keyValueList(h, { className: "gap-1 rounded-md border p-2" }, [
				keyValue(h, { label: "Trace ID", mono: true }, [
					copyableValue(h, model.copies, { id: "detail-trace-id", value: log.traceId }, [
						log.traceId,
					]),
				]),
				...(log.spanId
					? [
							keyValue(h, { label: "Span ID", mono: true }, [
								copyableValue(h, model.copies, { id: "detail-span-id", value: log.spanId }, [
									log.spanId,
								]),
							]),
						]
					: []),
			]),
			linkButton(
				h,
				{
					variant: "outline",
					size: "sm",
					className: "w-full gap-1.5",
					href,
					attributes: [h.OnClick(Message.ClosedSheet())],
				},
				[icon(h, "PulseIcon"), "Open trace"],
			),
		],
	)

const rawPanel = (h: HtmlBuilder<Message>, model: Model, log: LocalLog): Html => {
	const payload = buildLogJsonPayload(log)
	return h.div(
		[],
		[
			h.div(
				[h.Class("mb-2 flex items-center justify-between")],
				[
					h.span([h.Class("text-xs font-medium text-muted-foreground")], ["JSON Payload"]),
					CopyButton.view(h, {
						model: copyOf(model.copies, "detail-raw"),
						toParentMessage: (message) => Message.GotCopyMessage({ id: "detail-raw", message }),
						value: payload,
						label: "Log JSON",
						idleLabel: "Copy",
						iconSize: 10,
						className: "h-5 px-1.5 text-[10px]",
					}),
				],
			),
			h.pre(
				[
					h.Class(
						"whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed",
					),
				],
				[h.code([h.InnerHTML(highlightJson(payload))], [])],
			),
		],
	)
}

export const detailTabs = (h: HtmlBuilder<Message>, model: Model): Html => {
	const { log } = model
	const maybeHref = traceHrefOf(log)
	const panel = (value: string): ReadonlyArray<Html> | undefined => {
		if (value === "attributes")
			return padded(h, "log-detail-attributes", [
				h.submodel({
					slotId: "log-detail-attributes-panel",
					model: model.attributes,
					view: AttributesView.view,
					viewInputs: {
						logAttributes: log.logAttributes,
						resourceAttributes: log.resourceAttributes,
						canFilter: false,
						logTitle: "Log attributes",
						hasCommitShaValues: false,
					},
					toParentMessage: (message) => Message.GotAttributesMessage({ message }),
				}),
			])
		if (value === "trace")
			return Option.match(maybeHref, {
				onNone: () => undefined,
				onSome: (href) => padded(h, "log-detail-trace", [tracePanel(h, model, log, href)]),
			})
		return padded(h, "log-detail-raw", [rawPanel(h, model, log)])
	}
	return h.submodel({
		slotId: "log-detail-tabs",
		model: model.tabs,
		view: TabsView.view,
		viewInputs: {
			variant: "underline",
			labels: model.tabs.values.map((value) => TABS.get(value)?.label ?? value),
			tabContent: (value, label) => {
				const tab = TABS.get(value)
				return tab === undefined ? [label] : [icon(h, tab.icon, { size: 14 }), " ", label]
			},
			className: "flex min-h-0 flex-1 flex-col",
			listClassName: "shrink-0 px-4",
			panelClassName: "mt-0 min-h-0 flex-1",
			panel,
		},
		toParentMessage: (message) => Message.GotTabsMessage({ message }),
	})
}
