import type { SessionSummary } from "@maple/agent-sessions"
import { traceSessionTraceId } from "@maple/domain/gen-ai"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../ui/copy-button"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { moreChip } from "../kit/more-chip"
import { sessionIdentity } from "../kit/session-name"
import { vendorColor, vendorIcon } from "../kit/vendor"
import { detailTitle } from "../../kit/detail-header"
import { relativeTime } from "../../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"

// The session header: what ran, when, on what.

type H = HtmlBuilder<Message>

const ID_PREFIX_LENGTH = 32

/** "agent-runner +9": the first name, the rest as a chip that names them on hover. */
const firstPlusRest = (h: H, names: ReadonlyArray<string>): Html => {
	const [first, ...rest] = names
	return h.span(
		[h.Class("inline-flex min-w-0 items-baseline gap-1.5")],
		[
			h.span([h.Class("min-w-0 truncate")], [first ?? ""]),
			...(rest.length > 0 ? [moreChip(h, { count: rest.length, names: rest })] : []),
		],
	)
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
					"-mx-0.5 cursor-pointer rounded-sm px-0.5 text-left transition-colors",
					model.copy.status === "idle" && "hover:bg-surface-sunken active:bg-surface-sunken",
					model.copy.status === "copied" && "bg-severity-info-a3",
					model.copy.status === "error" && "bg-severity-error-a3",
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
	return detailTitle(h, {
		kind: [
			h.span(
				[h.Class("inline-flex items-center gap-1.5")],
				[
					icon(h, vendorIcon(vendorId), {
						size: 12,
						className: "shrink-0",
						style: { color: vendorColor(vendorId) },
						attributes: [h.AriaHidden(true)],
					}),
					"Agent session",
				],
			),
		],
		title: [heading],
		meta: [
			...(summary.failed ? [badge(h, { variant: "crit" }, ["Failed"])] : []),
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
							keyValue(h, { label: "Service", mono: true }, [
								firstPlusRest(h, summary.serviceNames),
							]),
						]
					: []),
				keyValue(h, { label: idLabel, title: id }, [
					copyableId(h, model, id, idLabel, [
						h.span(
							[h.Class("min-w-0 truncate")],
							[shortId(id, "generic", { length: ID_PREFIX_LENGTH, ellipsis: true })],
						),
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
