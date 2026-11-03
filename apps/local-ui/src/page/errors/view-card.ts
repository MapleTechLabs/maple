import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { pressable } from "@maple/views/ui/pressable"
import { hstackClass } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { serviceDot } from "@maple/views/ui/values"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ErrorTypeRow } from "./fetch"
import { cardTraces, relativeTime } from "./view-traces"
import { Message } from "./message"
import type { Card } from "./model"
import { Array as Arr } from "effect"

// One error type's card: the header toggles the traces panel.

type H = HtmlBuilder<Message>

const services = (h: H, row: ErrorTypeRow): ReadonlyArray<Html> =>
	row.serviceNames.length > 0
		? [
				...Arr.map(row.serviceNames, (serviceName) =>
					badge(h, { variant: "outline", size: "xs", mono: true, className: "gap-1.5" }, [
						serviceDot(h, { serviceName }),
						serviceName,
					]),
				),
				...(row.affectedServicesCount > row.serviceNames.length
					? [
							typography(h, { size: "xs", tone: "muted", className: "shrink-0" }, [
								"+",
								String(row.affectedServicesCount - row.serviceNames.length),
								" more",
							]),
						]
					: []),
			]
		: [
				typography(h, { size: "xs", tone: "muted", className: "shrink-0" }, [
					row.affectedServicesCount === 1 ? "1 service" : `${row.affectedServicesCount} services`,
				]),
			]

const header = (h: H, row: ErrorTypeRow, card: Card, panelId: string, nowMs: number): Html =>
	pressable(
		h,
		{
			onClick: Message.ClickedErrorType({ fingerprintHash: row.fingerprintHash }),
			className: hstackClass({
				gap: "3",
				className: "w-full px-4 py-3 text-left hover:bg-accent/40 active:bg-accent/40",
			}),
			attributes: [h.AriaExpanded(card.isExpanded), h.AriaControls(panelId)],
		},
		[
			icon(h, "CircleWarningIcon", { className: "size-4 shrink-0 text-severity-error" }),
			h.span(
				[h.Class("min-w-0 flex-1")],
				[
					h.span(
						[h.Class("flex flex-wrap items-baseline gap-x-2 gap-y-1")],
						[
							typography(h, { size: "sm", weight: "medium", truncate: true }, [
								row.errorLabel || "Unknown Error",
							]),
							...services(h, row),
						],
					),
					...(row.sampleMessage
						? [
								typography(
									h,
									{
										size: "xs",
										tone: "muted",
										mono: true,
										truncate: true,
										className: "block",
									},
									[row.sampleMessage],
								),
							]
						: []),
				],
			),
			h.span(
				[h.Class("shrink-0 text-right")],
				[
					typography(
						h,
						{ size: "sm", tone: "error", weight: "semibold", numeric: true, className: "block" },
						[formatNumber(row.count)],
					),
					typography(h, { size: "3xs", tone: "muted", className: "block" }, [
						"last seen ",
						relativeTime(row.lastSeen, nowMs),
					]),
				],
			),
			icon(h, "ChevronDownIcon", {
				className: cn(
					"size-4 shrink-0 text-muted-foreground transition-transform",
					card.isExpanded && "rotate-180",
				),
			}),
		],
	)

export const errorTypeCard = (
	h: H,
	row: ErrorTypeRow,
	card: Card,
	query: URLSearchParams,
	nowMs: number,
): Html => {
	const panelId = `error-traces-${row.fingerprintHash}`
	return h.div(
		[h.Key(row.fingerprintHash), h.Class("rounded-md border bg-card")],
		[
			header(h, row, card, panelId, nowMs),
			...(card.isExpanded
				? [
						h.div(
							[h.Id(panelId), h.Class("border-t px-4 py-2")],
							[cardTraces(h, row, card, query, nowMs)],
						),
					]
				: []),
		],
	)
}
