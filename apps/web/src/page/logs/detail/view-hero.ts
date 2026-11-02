import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { copyButton } from "../../../ui/copy-button"
import { badge } from "../../../ui/display"
import { severityBadge } from "../../../ui/logs/severity-badge"
import { icon } from "../../../ui/icon"
import { logMessageOf, logMessageView } from "../../../ui/logs/log-message"
import type { LogRecord } from "../../../ui/logs/log-row-view"
import { pressable } from "../../../ui/pressable"
import { textLink } from "../../../ui/text-link"
import { serviceDot } from "../../../ui/values"
import { severityLabel } from "./derive"
import { Message, type Model } from "./model"
import { copyStatusOf } from "./update"

type H = HtmlBuilder<Message>

/** A faint wash of the severity colour; unknown levels keep the plain border. */
const heroToneStyle = (severity: string): Readonly<Record<string, string>> | undefined => {
	const color = SEVERITY_COLORS[severity.toUpperCase()]
	return color === undefined
		? undefined
		: {
				"background-color": `color-mix(in oklch, ${color} 5%, transparent)`,
				"border-color": `color-mix(in oklch, ${color} 20%, transparent)`,
			}
}

/** `CopyableValue`: inline text that copies itself, tinted by the copy's outcome. */
export const copyable = (
	h: H,
	model: Model,
	copyId: string,
	value: string,
	children: ReadonlyArray<Html | string>,
): Html => {
	const status = copyStatusOf(model, copyId)
	return pressable(
		h,
		{
			label: "Copy value",
			onClick: Message.ClickedCopy({ copyId, text: value }),
			className: cn(
				"-mx-0.5 cursor-pointer rounded-sm px-0.5 text-left transition-colors",
				status === "idle" && "hover:bg-surface-sunken active:bg-surface-sunken",
				status === "copied" && "bg-severity-info-a3",
				status === "error" && "bg-severity-error-a3",
			),
			attributes: [h.Title("Click to copy")],
		},
		children,
	)
}

/** `LogTextButton`: the tiny muted text action. */
export const logTextButton = (
	h: H,
	className: string | undefined,
	onClick: Message,
	children: ReadonlyArray<Html | string>,
): Html =>
	textLink(h, { tone: "muted", onClick, className: cn("flex gap-1 text-3xs", className) }, children)

const severityTrigger = (h: H, log: LogRecord): Html =>
	h.span(
		[
			h.Class("cursor-help inline-flex"),
			h.DataAttribute("base-ui-tooltip-trigger", ""),
			h.DataAttribute("slot", "tooltip-trigger"),
			h.Id("log-detail-severity-trigger"),
		],
		[severityBadge(h, { severity: log.severityText, severityNumber: log.severityNumber })],
	)

export const heroHeader = (
	h: H,
	model: Model,
	log: LogRecord,
	/** `null`: `showClose={false}` on `/logs/$logId`. */
	close: ReadonlyArray<ChildAttribute> | null,
): Html => {
	const message = logMessageOf(log.body ?? "")
	const tone = heroToneStyle(severityLabel(log.severityText, log.severityNumber))
	return h.div(
		[h.Class("border-b px-4 py-3 shrink-0"), ...(tone === undefined ? [] : [h.Style(tone)])],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					severityTrigger(h, log),
					badge(h, { variant: "outline", size: "xs", mono: true }, [
						serviceDot(h, { serviceName: log.serviceName, size: "sm" }),
						copyable(h, model, "hero-service", log.serviceName, [log.serviceName]),
					]),
					...(close === null
						? []
						: [
								button(
									h,
									{
										variant: "ghost",
										size: "icon",
										className: "ml-auto shrink-0",
										slot: "sheet-close",
										attributes: [h.AriaLabel("Close"), h.Tabindex(0), ...close],
									},
									[icon(h, "XmarkIcon", { size: 16 })],
								),
							]),
				],
			),
			h.div(
				[h.Class("mt-3")],
				[
					h.div(
						[h.Class("flex items-start gap-1")],
						[
							logMessageView(h, message, model.isHeroExpanded),
							copyButton(h, {
								status: copyStatusOf(model, "hero-message"),
								label: "message",
								iconSize: 12,
								className: "-mt-0.5 shrink-0",
								onClick: Message.ClickedCopy({
									copyId: "hero-message",
									text: message.copyValue,
								}),
							}),
						],
					),
					...(message.isLong
						? [
								logTextButton(h, "mt-1.5", Message.ClickedShowFullMessage(), [
									model.isHeroExpanded ? "Show less" : "Show full message",
									icon(h, model.isHeroExpanded ? "ChevronUpIcon" : "ChevronDownIcon", {
										size: 10,
									}),
								]),
							]
						: []),
				],
			),
		],
	)
}
