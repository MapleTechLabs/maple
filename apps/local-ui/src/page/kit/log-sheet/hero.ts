import { getSeverityColor } from "@maple/ui/lib/severity"
import { button } from "@maple/web/ui/button"
import * as CopyButton from "@maple/web/ui/copy-button"
import { badge } from "@maple/web/ui/display"
import { icon } from "@maple/web/ui/icon"
import { logMessageOf, logMessageView } from "@maple/web/ui/logs/log-message"
import { serviceDot } from "@maple/web/ui/values"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "./message"
import type { Model } from "./model"
import { copyOf } from "../copies"
import { copyableValue, heroToneStyle, severityLabel } from "./parts"

/** `SeverityBadge`: the label in its colour on a 10% wash. */
const severityBadge = (h: HtmlBuilder<Message>, label: string): Html => {
	const color = getSeverityColor(label)
	return badge(
		h,
		{
			variant: "secondary",
			className: "font-mono text-3xs uppercase",
			attributes: [h.Style({ color, "background-color": `color-mix(in oklch, ${color} 10%, transparent)` })],
		},
		[label],
	)
}

/** `LogHeroHeader`: severity, service, close, and the (clamped) message. */
export const heroHeader = (h: HtmlBuilder<Message>, model: Model): Html => {
	const { log } = model
	const severity = severityLabel(log.severityText, log.severityNumber)
	const message = logMessageOf(log.body ?? "")
	const tone = heroToneStyle(severity)
	return h.div(
		[h.Class("shrink-0 border-b px-4 py-3"), ...(tone === undefined ? [] : [h.Style(tone)])],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					severityBadge(h, severity),
					badge(h, { variant: "outline", size: "xs", mono: true }, [
						serviceDot(h, { serviceName: log.serviceName, size: "sm" }),
						copyableValue(h, model.copies, { id: "detail-service", value: log.serviceName }, [log.serviceName]),
					]),
					button(
						h,
						{
							variant: "ghost",
							size: "icon",
							className: "ml-auto shrink-0",
							attributes: [h.AriaLabel("Close log details"), h.OnClick(Message.ClosedSheet())],
						},
						[icon(h, "XmarkIcon")],
					),
				],
			),
			h.div(
				[h.Class("mt-3")],
				[
					h.div([h.Class("flex items-start gap-1")], [
						logMessageView(h, message, model.isBodyExpanded),
						CopyButton.view(h, {
							model: copyOf(model.copies, "detail-body"),
							toParentMessage: (copy) => Message.GotCopyMessage({ id: "detail-body", message: copy }),
							value: message.copyValue,
							label: "message",
							iconSize: 12,
							className: "-mt-0.5 shrink-0",
						}),
					]),
					...(message.isLong
						? [
								h.button(
									[
										h.Type("button"),
										h.OnClick(Message.ToggledBodyExpanded()),
										h.Class(
											"mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground",
										),
									],
									[
										model.isBodyExpanded ? "Show less" : "Show full message",
										icon(h, model.isBodyExpanded ? "ChevronUpIcon" : "ChevronDownIcon", { size: 10 }),
									],
								),
							]
						: []),
				],
			),
		],
	)
}
