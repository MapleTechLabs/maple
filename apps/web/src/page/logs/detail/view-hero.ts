import { stripAnsi } from "@maple/ui/components/logs/strip-ansi"
import { getSeverityColor, SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { highlightCode } from "../../../lib/highlight"
import { Option } from "effect"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { tryParseJson } from "../../../ui/attributes/attribute-row"
import { button } from "../../../ui/button"
import { copyButton } from "../../../ui/copy-button"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import type { LogRecord } from "../../../ui/logs/log-row-view"
import { serviceDot } from "../../../ui/values"
import { severityLabel } from "./derive"
import { Message, type Model } from "./model"
import { copyStatusOf } from "./update"

type H = HtmlBuilder<Message>

const BODY_LINE_THRESHOLD = 280

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
	return h.button(
		[
			h.Type("button"),
			h.AriaLabel("Copy value"),
			h.Class(
				cn(
					"-mx-0.5 cursor-pointer rounded px-0.5 text-left transition-colors",
					status === "idle" && "hover:bg-muted/50",
					status === "copied" && "bg-severity-info/20",
					status === "error" && "bg-severity-error/20",
				),
			),
			h.OnClick(Message.ClickedCopy({ copyId, text: value })),
			h.Title("Click to copy"),
		],
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
	h.button(
		[
			h.Type("button"),
			h.Class(
				cn(
					"flex cursor-pointer items-center gap-1 text-3xs text-muted-foreground transition-colors hover:text-foreground",
					className,
				),
			),
			h.OnClick(onClick),
		],
		children,
	)

const severityBadge = (h: H, log: LogRecord): Html => {
	const label = severityLabel(log.severityText, log.severityNumber)
	const color = getSeverityColor(label)
	return h.span(
		[
			h.Class("cursor-help inline-flex"),
			h.DataAttribute("base-ui-tooltip-trigger", ""),
			h.DataAttribute("slot", "tooltip-trigger"),
			h.Id("log-detail-severity-trigger"),
		],
		[
			badge(
				h,
				{
					variant: "secondary",
					className: "font-mono text-3xs uppercase",
					attributes: [
						h.Style({
							color,
							"background-color": `color-mix(in oklch, ${color} 10%, transparent)`,
						}),
					],
				},
				[label],
			),
		],
	)
}

/** The message: a JSON body pretty-printed and highlighted, anything else as plain text. */
const message = (
	h: H,
	parsed: Option.Option<unknown>,
	displayBody: string,
	formatted: string,
	clamp: boolean,
) =>
	Option.isSome(parsed)
		? h.pre(
				[
					h.Class(
						cn(
							"font-mono text-ui leading-relaxed whitespace-pre-wrap break-words",
							clamp && "line-clamp-6",
						),
					),
				],
				[h.code([h.InnerHTML(highlightCode(formatted, "json"))], [])],
			)
		: h.p(
				[
					h.Class(
						cn(
							"font-mono text-sm leading-relaxed whitespace-pre-wrap break-words",
							clamp && "line-clamp-4",
						),
					),
				],
				[displayBody],
			)

export const heroHeader = (
	h: H,
	model: Model,
	log: LogRecord,
	/** `null`: `showClose={false}` on `/logs/$logId`. */
	close: ReadonlyArray<ChildAttribute> | null,
): Html => {
	const body = log.body ?? ""
	const parsed = tryParseJson(body)
	const formatted = Option.isSome(parsed) ? JSON.stringify(parsed.value, null, 2) : body
	const isLong = formatted.length > BODY_LINE_THRESHOLD || formatted.includes("\n")
	const tone = heroToneStyle(severityLabel(log.severityText, log.severityNumber))
	return h.div(
		[h.Class("border-b px-4 py-3 shrink-0"), ...(tone === undefined ? [] : [h.Style(tone)])],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					severityBadge(h, log),
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
							h.div(
								[
									h.Class(
										cn(
											"min-w-0 flex-1 select-text",
											model.isHeroExpanded && "max-h-[45vh] overflow-auto",
										),
									),
								],
								[
									message(
										h,
										parsed,
										stripAnsi(body),
										formatted,
										isLong && !model.isHeroExpanded,
									),
								],
							),
							copyButton(h, {
								status: copyStatusOf(model, "hero-message"),
								label: "message",
								iconSize: 12,
								className: "-mt-0.5 shrink-0",
								onClick: Message.ClickedCopy({
									copyId: "hero-message",
									text: Option.isSome(parsed) ? formatted : body,
								}),
							}),
						],
					),
					...(isLong
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
