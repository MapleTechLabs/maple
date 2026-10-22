import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { badge } from "@maple/web/ui/display"
import { icon } from "@maple/web/ui/icon"
import { serviceDot } from "@maple/web/ui/values"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ErrorTypeRow } from "./fetch"
import { cardTraces, relativeTime } from "./view-traces"
import { Message } from "./message"
import type { Card } from "./model"

// One error type's card: the header toggles the traces panel.

type H = HtmlBuilder<Message>

const services = (h: H, row: ErrorTypeRow): ReadonlyArray<Html> =>
	row.serviceNames.length > 0
		? [
				...row.serviceNames.map((serviceName) =>
					badge(h, { variant: "outline", size: "xs", mono: true, className: "gap-1.5" }, [
						serviceDot(h, { serviceName }),
						serviceName,
					]),
				),
				...(row.affectedServicesCount > row.serviceNames.length
					? [
							h.span(
								[h.Class("shrink-0 text-xs text-muted-foreground")],
								["+", String(row.affectedServicesCount - row.serviceNames.length), " more"],
							),
						]
					: []),
			]
		: [
				h.span(
					[h.Class("shrink-0 text-xs text-muted-foreground")],
					[row.affectedServicesCount === 1 ? "1 service" : `${row.affectedServicesCount} services`],
				),
			]

const header = (h: H, row: ErrorTypeRow, card: Card, panelId: string, nowMs: number): Html =>
	h.button(
		[
			h.Type("button"),
			h.OnClick(Message.ClickedErrorType({ fingerprintHash: row.fingerprintHash })),
			h.AriaExpanded(card.isExpanded),
			h.AriaControls(panelId),
			h.Class("flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"),
		],
		[
			icon(h, "CircleWarningIcon", { className: "size-4 shrink-0 text-severity-error" }),
			h.span(
				[h.Class("min-w-0 flex-1")],
				[
					h.span(
						[h.Class("flex flex-wrap items-baseline gap-x-2 gap-y-1")],
						[h.span([h.Class("truncate text-sm font-medium")], [row.errorLabel || "Unknown Error"]), ...services(h, row)],
					),
					...(row.sampleMessage
						? [h.span([h.Class("block truncate font-mono text-xs text-muted-foreground")], [row.sampleMessage])]
						: []),
				],
			),
			h.span(
				[h.Class("shrink-0 text-right")],
				[
					h.span([h.Class("block text-sm font-semibold tabular-nums text-severity-error")], [formatNumber(row.count)]),
					h.span([h.Class("block text-[10px] text-muted-foreground")], ["last seen ", relativeTime(row.lastSeen, nowMs)]),
				],
			),
			icon(h, "ChevronDownIcon", {
				className: cn("size-4 shrink-0 text-muted-foreground transition-transform", card.isExpanded && "rotate-180"),
			}),
		],
	)

export const errorTypeCard = (h: H, row: ErrorTypeRow, card: Card, query: URLSearchParams, nowMs: number): Html => {
	const panelId = `error-traces-${row.fingerprintHash}`
	return h.div(
		[h.Key(row.fingerprintHash), h.Class("rounded-md border bg-card")],
		[
			header(h, row, card, panelId, nowMs),
			...(card.isExpanded
				? [h.div([h.Id(panelId), h.Class("border-t px-4 py-2")], [cardTraces(h, row, card, query, nowMs)])]
				: []),
		],
	)
}
