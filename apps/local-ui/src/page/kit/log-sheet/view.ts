import { formatUtcTitle } from "../../../lib/time"
import { parseErrorBody } from "@maple/ui/lib/error-body"
import { formatErrorPrompt } from "@maple/ui/lib/error-prompt"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { sheetTitleStyles } from "@maple/ui/styles/ui/sheet"
import * as CopyButton from "@maple/web/ui/copy-button"
import { titleId } from "@maple/web/ui/dialog"
import * as DialogView from "@maple/web/ui/dialog-view"
import { errorSectionView } from "@maple/web/ui/error-section"
import { icon } from "@maple/web/ui/icon"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { copyOf } from "../copies"
import { formatDateTime, type TimeFormat } from "../local-time"
import { heroHeader } from "./hero"
import { Message } from "./message"
import type { LocalLog, Model } from "./model"
import { buildLogJsonPayload, copyableValue, severityLabel, traceHrefOf } from "./parts"
import { detailTabs } from "./tabs"

// The log detail sheet in the kit's Sheet, which
// portals it to `<body>`, marks the page outside it, locks scroll and traps focus.

type H = HtmlBuilder<Message>

const copyClick = (id: string, text: string) => Message.GotCopyMessage({ id, message: CopyButton.Message.ClickedCopy({ text }) })

const metaStrip = (h: H, model: Model, timeFormat: TimeFormat): Html => {
	const { log } = model
	return h.div([h.Class("flex shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b px-4 py-1.5 text-xs")], [
		h.div([h.Class("flex shrink-0 items-center gap-1.5")], [
			icon(h, "ClockIcon", { size: 12, className: "text-muted-foreground" }),
			h.span([h.Class("font-mono"), h.Title(formatUtcTitle(log.timestamp))], [
				copyableValue(h, model.copies, { id: "detail-time", value: log.timestamp }, [formatDateTime(timeFormat, log.timestamp)]),
			]),
		]),
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
					h.span([h.Class("shrink-0 font-mono text-[11px] text-muted-foreground")], [
						copyableValue(h, model.copies, { id: "detail-span", value: log.spanId }, ["span:", shortId(log.spanId, "span")]),
					]),
				]
			: []),
		h.div([h.Class("ml-auto flex shrink-0 items-center gap-0.5")], [
			// TODO(tooltip): legacy wraps this copy button in a tooltip.
			CopyButton.view(h, {
				model: copyOf(model.copies, "detail-json"),
				toParentMessage: (message) => Message.GotCopyMessage({ id: "detail-json", message }),
				value: buildLogJsonPayload(log),
				label: "Log JSON",
				iconSize: 13,
			}),
		]),
	])
}

/** `LogErrorBanner` for ERROR / FATAL / CRITICAL: the exception message (else the body). */
const errorBanner = (h: H, model: Model, log: LocalLog): ReadonlyArray<Html> => {
	const severity = severityLabel(log.severityText, log.severityNumber).toUpperCase()
	if (severity !== "ERROR" && severity !== "FATAL" && severity !== "CRITICAL") return []
	const message = log.logAttributes["exception.message"] ?? log.logAttributes["error.message"] ?? log.body
	if (message === "") return []
	const prompt = formatErrorPrompt({ message, serviceName: log.serviceName, attributes: { ...log.logAttributes } })
	return [
		errorSectionView(h, {
			message,
			title: log.severityText.toUpperCase() === "FATAL" ? "Fatal" : "Error",
			badge: log.logAttributes["exception.type"] ?? log.logAttributes["error.type"],
			isExpanded: model.isErrorExpanded,
			onToggle: Message.ToggledErrorExpanded(),
			bodyStatus: copyOf(model.copies, "error-body").status,
			onCopyBody: copyClick("error-body", parseErrorBody(message).full),
			// TODO(tooltip): legacy's prompt copy button carries a hover tooltip.
			prompt: { status: copyOf(model.copies, "error-prompt").status, onCopy: copyClick("error-prompt", prompt) },
		}),
	]
}

const content = (h: H, model: Model, timeFormat: TimeFormat): ReadonlyArray<Html> => [
	h.h2([h.Class(cn(sheetTitleStyles, "sr-only")), h.DataAttribute("slot", "sheet-title"), h.Id(titleId(model.dialog.id))], [
		"Log: ",
		model.log.body.slice(0, 80),
	]),
	heroHeader(h, model),
	metaStrip(h, model, timeFormat),
	...errorBanner(h, model, model.log),
	detailTabs(h, model),
]

export type ViewInputs = Readonly<{ timeFormat: TimeFormat }>

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
	h.submodel({
		slotId: `${model.dialog.id}-sheet`,
		model: model.dialog,
		view: DialogView.view,
		viewInputs: {
			className: "flex flex-col p-0 sm:max-w-2xl",
			side: "right",
			hasTrigger: false,
			showCloseButton: false,
			hasDescription: false,
			toView: ({ portal }) => portal,
			toContent: () => content(h, model, inputs.timeFormat),
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	}),
)
