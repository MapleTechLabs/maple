import { formatLocalDateTime, formatUtcTitle } from "@maple/local-ui/lib/time"
import { shortId } from "@maple/ui/lib/ids"
import * as CopyButton from "@maple/web-foldkit/ui/copy-button"
import { icon } from "@maple/web-foldkit/ui/icon"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { copyOf } from "../kit/copies"
import { Message } from "./message"
import type { Detail, LocalLog, Model } from "./model"
import { rightSheet } from "./view-sheet-frame"
import { heroHeader } from "./view-sheet-hero"
import { buildLogJsonPayload, copyableValue, traceHrefOf } from "./view-sheet-parts"
import { detailTabs } from "./view-sheet-tabs"

// `LogDetailSheet` (apps/local-ui/src/components/log-detail-sheet.tsx).
// TODO(error-banner): `LogErrorBanner` (ErrorSection) for ERROR/FATAL logs is not ported in the kit.

const toCopy = (id: string) => (message: CopyButton.Message) => Message.GotCopyMessage({ id, message })

const metaStrip = (h: HtmlBuilder<Message>, model: Model, log: LocalLog): Html =>
	h.div(
		[h.Class("flex shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b px-4 py-1.5 text-xs")],
		[
			h.div(
				[h.Class("flex shrink-0 items-center gap-1.5")],
				[
					icon(h, "ClockIcon", { size: 12, className: "text-muted-foreground" }),
					h.span([h.Class("font-mono"), h.Title(formatUtcTitle(log.timestamp))], [
						copyableValue(h, model.copies, { id: "detail-time", value: log.timestamp }, [formatLocalDateTime(log.timestamp)]),
					]),
				],
			),
			...Option.match(traceHrefOf(log), {
				onNone: () => [],
				onSome: (href) => [
					h.a(
						[
							h.Href(href),
							h.OnClick(Message.ClosedDetail()),
							h.Class(
								"inline-flex shrink-0 items-center gap-1 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/10",
							),
							h.Title(`View trace ${log.traceId}`),
						],
						[icon(h, "PulseIcon", { size: 10 }), "trace:", shortId(log.traceId, "trace")],
					),
				],
			}),
			...(log.spanId
				? [
						h.span([h.Class("shrink-0 font-mono text-[11px] text-muted-foreground")], [
							copyableValue(h, model.copies, { id: "detail-span", value: log.spanId }, ["span:", shortId(log.spanId, "span")]),
						]),
					]
				: []),
			h.div([h.Class("ml-auto flex shrink-0 items-center gap-0.5")], [
				// TODO(tooltip): legacy wraps this copy button in a tooltip.
				CopyButton.view(h, {
					model: copyOf(model.copies, "detail-json"),
					toParentMessage: toCopy("detail-json"),
					value: buildLogJsonPayload(log),
					label: "Log JSON",
					iconSize: 13,
				}),
			]),
		],
	)

export const detailSheet = (h: HtmlBuilder<Message>, model: Model, detail: Detail): Html =>
	rightSheet(
		h,
		{
			id: "log-detail-sheet",
			className: "flex flex-col p-0 sm:max-w-2xl",
			title: ["Log: ", detail.log.body.slice(0, 80)],
			onDismiss: Message.ClosedDetail(),
		},
		[heroHeader(h, model, detail), metaStrip(h, model, detail.log), detailTabs(h, model, detail)],
	)
