import { formatUtcTitle } from "../../../lib/time"
import { parseErrorBody } from "@maple/ui/lib/error-body"
import { formatErrorPrompt } from "@maple/ui/lib/error-prompt"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { sheetTitleStyles } from "@maple/ui/styles/ui/sheet"
import type { CopyStatus } from "@maple/web/ui/copy-button"
import { titleId } from "@maple/web/ui/dialog"
import { errorSectionView } from "@maple/web/ui/error-section"
import { icon } from "@maple/web/ui/icon"
import { Option } from "effect"
import type { ChildAttribute, Html } from "foldkit/html"
import { copiesButton, copyOf } from "../copies"
import { formatDateTime, type TimeFormat } from "../local-time"
import { DialogBinding, LogSheetComposition, type LogSheetViewBuilder, TooltipBinding } from "./composition"
import { heroHeader } from "./hero"
import { Message } from "./message"
import { JSON_COPY_TRIGGER, type LocalLog, type Model, PROMPT_COPY_TRIGGER } from "./model"
import {
	buildLogJsonPayload,
	copyClick,
	copyableValue,
	severityLabel,
	toCopyMessage,
	traceHrefOf,
} from "./parts"
import { detailTabs } from "./tabs"

// The log detail sheet in the kit's Sheet, which
// portals it to `<body>`, marks the page outside it, locks scroll and traps focus.

type H = LogSheetViewBuilder
type Trigger = (id: string) => ReadonlyArray<ChildAttribute>
/** The tooltip's portal when it is anchored to `id`. Each trigger keeps it in its own parent, since
 * the portal lives in `<body>` and a keyed swap between triggers in one parent cannot find it. */
type PortalFor = (id: string) => ReadonlyArray<Html>
type TooltipParts = Readonly<{ trigger: Trigger; portalFor: PortalFor }>

/** `copyTooltipText`: the tooltip follows the copy status. */
const copyTooltipText = (status: CopyStatus, label: string, copiedLabel = "Copied"): string =>
	status === "copied" ? copiedLabel : status === "error" ? "Failed to copy" : `Copy ${label}`

const metaStrip = (
	h: H,
	model: Model,
	timeFormat: TimeFormat,
	{ trigger, portalFor }: TooltipParts,
): Html => {
	const { log } = model
	return h.div(
		[
			h.Class(
				"flex shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b px-4 py-1.5 text-xs",
			),
		],
		[
			h.div(
				[h.Class("flex shrink-0 items-center gap-1.5")],
				[
					icon(h, "ClockIcon", { size: 12, className: "text-muted-foreground" }),
					h.span(
						[h.Class("font-mono"), h.Title(formatUtcTitle(log.timestamp))],
						[
							copyableValue(h, model.copies, { id: "detail-time", value: log.timestamp }, [
								formatDateTime(timeFormat, log.timestamp),
							]),
						],
					),
				],
			),
			...Option.match(traceHrefOf(log), {
				onNone: () => [],
				onSome: (href) => [
					h.a(
						[
							h.Href(href),
							h.OnClick(Message.ClosedSheet()),
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
						h.span(
							[h.Class("shrink-0 font-mono text-[11px] text-muted-foreground")],
							[
								copyableValue(h, model.copies, { id: "detail-span", value: log.spanId }, [
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
					copiesButton(h, {
						copies: model.copies,
						id: "detail-json",
						toMessage: toCopyMessage,
						value: buildLogJsonPayload(log),
						label: "Log JSON",
						iconSize: 13,
						slot: "tooltip-trigger",
						attributes: trigger(JSON_COPY_TRIGGER),
					}),
					...portalFor(JSON_COPY_TRIGGER),
				],
			),
		],
	)
}

/** `LogErrorBanner` for ERROR / FATAL / CRITICAL: the exception message (else the body). */
const errorBanner = (
	h: H,
	model: Model,
	log: LocalLog,
	{ trigger, portalFor }: TooltipParts,
): ReadonlyArray<Html> => {
	const severity = severityLabel(log.severityText, log.severityNumber).toUpperCase()
	if (severity !== "ERROR" && severity !== "FATAL" && severity !== "CRITICAL") return []
	const message = log.logAttributes["exception.message"] ?? log.logAttributes["error.message"] ?? log.body
	if (message === "") return []
	const prompt = formatErrorPrompt({
		message,
		serviceName: log.serviceName,
		attributes: { ...log.logAttributes },
	})
	return [
		h.div(
			[h.Class("contents")],
			[
				errorSectionView(h, {
					message,
					title: log.severityText.toUpperCase() === "FATAL" ? "Fatal" : "Error",
					badge: log.logAttributes["exception.type"] ?? log.logAttributes["error.type"],
					isExpanded: model.isErrorExpanded,
					onToggle: Message.ToggledErrorExpanded(),
					bodyStatus: copyOf(model.copies, "error-body").status,
					onCopyBody: copyClick("error-body", parseErrorBody(message).full),
					prompt: {
						status: copyOf(model.copies, "error-prompt").status,
						onCopy: copyClick("error-prompt", prompt),
						trigger: trigger(PROMPT_COPY_TRIGGER),
					},
				}),
				...portalFor(PROMPT_COPY_TRIGGER),
			],
		),
	]
}

const tooltipContent = (model: Model, triggerId: string): ReadonlyArray<string> =>
	triggerId === PROMPT_COPY_TRIGGER
		? [
				copyTooltipText(
					copyOf(model.copies, "error-prompt").status,
					"error as an AI prompt",
					"Prompt copied",
				),
			]
		: [copyTooltipText(copyOf(model.copies, "detail-json").status, "Log JSON")]

const sheetBody = (
	h: H,
	model: Model,
	timeFormat: TimeFormat,
	tooltip: TooltipParts,
): ReadonlyArray<Html> => [
	h.h2(
		[
			h.Class(cn(sheetTitleStyles, "sr-only")),
			h.DataAttribute("slot", "sheet-title"),
			h.Id(titleId(model.dialog.id)),
		],
		["Log: ", model.log.body.slice(0, 80)],
	),
	heroHeader(h, model),
	metaStrip(h, model, timeFormat, tooltip),
	...errorBanner(h, model, model.log, tooltip),
	detailTabs(h, model),
]

/** The sheet's content, wrapped in the copy buttons' one Tooltip. */
const content = (h: H, model: Model, timeFormat: TimeFormat): ReadonlyArray<Html> => [
	h.block(
		TooltipBinding.embedView({
			slotId: `${model.tooltip.id}-slot`,
			model: model.tooltip,
			viewInputs: {
				triggerIds: [JSON_COPY_TRIGGER, PROMPT_COPY_TRIGGER],
				toContent: (triggerId) => tooltipContent(model, triggerId),
				toView: ({ trigger, portal }) =>
					h.div(
						[h.Class("contents")],
						sheetBody(h, model, timeFormat, {
							trigger,
							portalFor: (id) =>
								portal !== null && model.tooltip.triggerId === id ? [portal] : [],
						}),
					),
			},
		}),
	),
]

export type ViewInputs = Readonly<{ timeFormat: TimeFormat }>

/** The sheet in the kit's Sheet dialog; its parent embeds it with `LogSheetBinding.embedView`. */
export const view = LogSheetComposition.makeView.withInputs<ViewInputs>((model, inputs, h) =>
	h.block(
		DialogBinding.embedView({
			slotId: `${model.dialog.id}-sheet`,
			model: model.dialog,
			viewInputs: {
				className: "flex flex-col p-0 sm:max-w-2xl",
				side: "right",
				hasTrigger: false,
				showCloseButton: false,
				hasDescription: false,
				toView: ({ portal }) => portal,
				toContent: () => content(h, model, inputs.timeFormat),
			},
		}),
	),
)
