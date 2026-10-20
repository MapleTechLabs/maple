import type { SessionSummary } from "@maple/agent-sessions"
import { traceSessionTraceId } from "@maple/domain/gen-ai"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../ui/copy-button"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { pageTitle } from "../../../ui/page-layout"
import { sessionIdentity } from "../kit/session-name"
import { vendorColor, vendorIcon } from "../kit/vendor"
import { relativeTime } from "../../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"

// The session header: what ran, when, on what.

type H = HtmlBuilder<Message>

const ID_PREFIX_LENGTH = 32

/** "claude-sonnet-5 +1": the first name, the rest as a count. */
const firstPlusRest = (names: ReadonlyArray<string>): string => {
	const [first, ...rest] = names
	if (first === undefined) return ""
	return rest.length > 0 ? `${first} +${rest.length}` : first
}

/** `CopyableValue`: the id that copies itself, tinted by the copy's outcome. */
const copyableId = (
	h: H,
	model: Model,
	value: string,
	label: string,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.button(
		[
			h.AriaLabel(`Copy ${label}`),
			h.Class(
				cn(
					"-mx-0.5 cursor-pointer rounded px-0.5 text-left transition-colors",
					model.copy.status === "idle" && "hover:bg-muted/50",
					model.copy.status === "copied" && "bg-severity-info/20",
					model.copy.status === "error" && "bg-severity-error/20",
					"inline-flex min-w-0 max-w-full items-center gap-1 font-mono",
				),
			),
			h.Title("Click to copy"),
			h.Type("button"),
			h.OnClick(Message.GotCopyMessage({ message: CopyButton.Message.ClickedCopy({ text: value }) })),
		],
		children,
	)

export const sessionHeader = (h: H, model: Model, summary: SessionSummary, timeZone: string): Html => {
	const heading = sessionIdentity(summary)
	const vendorId = summary.vendorIds[0] ?? ""
	const traceId = traceSessionTraceId(model.sessionId)
	const idLabel = traceId === undefined ? "Session ID" : "Trace ID"
	const id = traceId ?? model.sessionId
	return h.div(
		[h.Class("flex min-w-0 flex-col gap-2")],
		[
			h.div(
				[h.Class("flex min-w-0 items-center gap-2")],
				[
					icon(h, vendorIcon(vendorId), {
						size: 18,
						className: "shrink-0",
						style: { color: vendorColor(vendorId) },
						attributes: [h.AriaHidden(true)],
					}),
					pageTitle(h, { title: heading }, [heading]),
					...(summary.failed ? [badge(h, { variant: "crit" }, ["Failed"])] : []),
				],
			),
			keyValueList(h, { layout: "inline" }, [
				keyValue(h, { label: "Started" }, [
					relativeTime(h, {
						value: summary.startMs,
						variant: "orDate",
						tooltip: "title",
						nowMs: model.nowMs,
						timeZone,
						className: "",
					}),
				]),
				...(summary.serviceNames.length > 0
					? [
							keyValue(
								h,
								{ label: "Service", title: summary.serviceNames.join(", "), mono: true },
								[firstPlusRest(summary.serviceNames)],
							),
						]
					: []),
				keyValue(h, { label: idLabel, title: id }, [
					copyableId(h, model, id, idLabel, [
						h.span(
							[h.Class("min-w-0 truncate")],
							[shortId(id, "generic", { length: ID_PREFIX_LENGTH, ellipsis: true })],
						),
						icon(h, "CopyIcon", {
							size: 11,
							className: "shrink-0 text-muted-foreground",
							attributes: [h.AriaHidden(true)],
						}),
					]),
				]),
			]),
		],
	)
}
