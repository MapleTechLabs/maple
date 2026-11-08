import type { SessionSummary } from "@maple/agent-sessions"
import { traceSessionTraceId } from "@maple/domain/gen-ai"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "@maple/views/ui/copy-button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { pressable } from "@maple/views/ui/pressable"
import { moreChip } from "../kit/more-chip"
import { sessionIdentity } from "../kit/session-name"
import { vendorColor, vendorIcon } from "../kit/vendor"
import { detailTitle } from "../../kit/detail-header"
import { relativeTime } from "../../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// The session header: what ran, when, on what.

type H = HtmlBuilder<Message>

const ID_PREFIX_LENGTH = 32

/** "agent-runner +9": the first name, the rest as a chip that names them on hover. */
const firstPlusRest = (h: H, names: ReadonlyArray<string>): Html => {
	const [first, ...rest] = names
	return hstack(h, { gap: "1.5", align: "baseline", shrink: true, inline: true, as: "span" }, [
		typography(h, { truncate: true, className: "min-w-0" }, [first ?? ""]),
		...(rest.length > 0 ? [moreChip(h, { count: rest.length, names: rest })] : []),
	])
}

/** `CopyableValue`: the id that copies itself, tinted by the copy's outcome. */
const copyableId = (
	h: H,
	model: Model,
	value: string,
	label: string,
	children: ReadonlyArray<Html | string>,
): Html =>
	pressable(
		h,
		{
			onClick: Message.GotCopyMessage({ message: CopyButton.Message.ClickedCopy({ text: value }) }),
			label: `Copy ${label}`,
			className: cn(
				"-mx-0.5 rounded-sm px-0.5 text-left transition-colors",
				model.copy.status === "idle" && "hover:bg-surface-sunken active:bg-surface-sunken",
				model.copy.status === "copied" && "bg-severity-info-a3",
				model.copy.status === "error" && "bg-severity-error-a3",
				"inline-flex min-w-0 max-w-full items-center gap-1 font-mono",
			),
			attributes: [h.Title("Click to copy")],
		},
		children,
	)

export const sessionHeader = (h: H, model: Model, summary: SessionSummary, timeZone: string): Html => {
	const heading = sessionIdentity(summary)
	const vendorId = summary.vendorIds[0] ?? ""
	const traceId = traceSessionTraceId(model.sessionId)
	const idLabel = traceId === undefined ? "Session ID" : "Trace ID"
	const id = traceId ?? model.sessionId
	return detailTitle(h, {
		kind: [
			hstack(h, { gap: "1.5", inline: true, as: "span" }, [
				icon(h, vendorIcon(vendorId), {
					size: 12,
					className: "shrink-0",
					style: { color: vendorColor(vendorId) },
					attributes: [h.AriaHidden(true)],
				}),
				"Agent session",
			]),
		],
		title: [heading],
		meta: [
			...(summary.failed ? [badge(h, { variant: "crit" }, ["Failed"])] : []),
			keyValueList(h, { layout: "inline" }, [
				keyValue(h, { label: "Started" }, [
					relativeTime(h, {
						value: summary.startMs,
						variant: "orDate",
						nowMs: model.nowMs,
						timeZone,
						className: "",
					}),
				]),
				...(summary.serviceNames.length > 0
					? [
							keyValue(h, { label: "Service", mono: true }, [
								firstPlusRest(h, summary.serviceNames),
							]),
						]
					: []),
				keyValue(h, { label: idLabel, title: id }, [
					copyableId(h, model, id, idLabel, [
						typography(h, { truncate: true, className: "min-w-0" }, [
							shortId(id, "generic", { length: ID_PREFIX_LENGTH, ellipsis: true }),
						]),
						icon(h, "CopyIcon", {
							size: 12,
							className: "shrink-0 text-muted-foreground",
							attributes: [h.AriaHidden(true)],
						}),
					]),
				]),
			]),
		],
	})
}
