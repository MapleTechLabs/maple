import { shortId } from "@maple/ui/lib/ids"
import { encodeLogKey } from "@maple/views/lib/log-key"
import type { SpanId, TraceId } from "@maple/domain"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "@maple/views/ui/button"
import { copyButton, type CopyStatus } from "@maple/views/ui/copy-button"
import { icon } from "@maple/views/ui/icon"
import { timestamp } from "@maple/views/ui/timestamp"
import type { LogRecord } from "@maple/views/ui/logs/log-row-view"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { buildLogJsonPayload } from "./derive"
import { Message, type Model } from "./model"
import { copyStatusOf } from "./update"
import { copyable } from "./view-hero"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The log's meta strip, as the drawer shows it.

type H = HtmlBuilder<Message>

/** The sheet's one Tooltip: a trigger's attributes, and its portal placed beside that trigger. */
export type TooltipParts = Readonly<{
	trigger: (id: string) => ReadonlyArray<ChildAttribute>
	portalFor: (id: string) => ReadonlyArray<Html>
}>

const TRIGGERS = {
	json: "copy-json",
	link: "copy-link",
	page: "open-full-page",
	prompt: "copy-prompt",
} as const

export const triggerIdOf = (model: Model, trigger: keyof typeof TRIGGERS): string =>
	`${model.id}-${TRIGGERS[trigger]}`

export const triggerIdsOf = (model: Model): ReadonlyArray<string> =>
	Arr.map(["json", "link", "page", "prompt"] as const, (trigger) => triggerIdOf(model, trigger))

/** `copyTooltipText`: the tooltip follows the copy status. */
const copyTooltipText = (status: CopyStatus, label: string, copiedLabel = "Copied"): string =>
	status === "copied" ? copiedLabel : status === "error" ? "Couldn't copy" : `Copy ${label}`

export const tooltipContent = (model: Model, triggerId: string): ReadonlyArray<string> => {
	if (triggerId === triggerIdOf(model, "page")) return ["Open in full page"]
	if (triggerId === triggerIdOf(model, "link"))
		return [copyTooltipText(copyStatusOf(model, "meta-link"), "link to log", "Link copied")]
	if (triggerId === triggerIdOf(model, "prompt"))
		return [
			copyTooltipText(copyStatusOf(model, "error-prompt"), "error as an AI prompt", "Prompt copied"),
		]
	return [copyTooltipText(copyStatusOf(model, "meta-json"), "log JSON")]
}

/** What the meta strip takes from the app: its clock, and where the trace link goes. */
export type MetaInputs = Readonly<{
	timeZone: string
	/** The reader's clock; the formatter's locale default without it. */
	hourCycle?: "h12" | "h23" | undefined
	/** The app's URL for the log's trace (at its span when it can). */
	traceHref: (traceId: TraceId, spanId: SpanId | undefined, timestamp: string) => string
}>

export const metaStrip = (
	h: H,
	model: Model,
	log: LogRecord,
	{ timeZone, hourCycle, traceHref }: MetaInputs,
	{ trigger, portalFor }: TooltipParts,
	showOpenFullPage = true,
): Html =>
	h.div(
		[
			h.Class(
				"flex items-center gap-2 overflow-x-auto border-b px-4 py-1.5 text-xs shrink-0 whitespace-nowrap",
			),
		],
		[
			hstack(h, { gap: "1.5", className: "shrink-0" }, [
				icon(h, "ClockIcon", { size: 12, className: "text-muted-foreground" }),
				h.span(
					[h.Class("font-mono")],
					[
						copyable(h, model, "meta-time", log.timestamp, [
							timestamp(h, {
								value: log.timestamp,
								timeZone,
								withMilliseconds: true,
								className: "cursor-pointer",
								label: formatTimestampInTimezone(log.timestamp, {
									timeZone,
									withMilliseconds: true,
									hourCycle,
								}),
							}),
						]),
					],
				),
			]),
			...(log.traceId
				? [
						h.a(
							[
								h.Class(
									"inline-flex shrink-0 items-center gap-1 rounded-sm border border-primary-a3 bg-primary-a1 px-1.5 py-0.5 font-mono text-2xs text-primary hover:bg-primary-a2 active:bg-primary-a2",
								),
								h.Href(traceHref(log.traceId, log.spanId, log.timestamp)),
								h.Title(`View trace ${log.traceId}`),
							],
							[icon(h, "PulseIcon", { size: 12 }), "trace:", shortId(log.traceId, "trace")],
						),
					]
				: []),
			...(log.spanId
				? [
						h.span(
							[h.Class("shrink-0 font-mono text-2xs text-muted-foreground")],
							[
								copyable(h, model, "meta-span", log.spanId, [
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
					...(model.logPagePath === null
						? []
						: logPageControls(h, model, log, model.logPagePath, showOpenFullPage, {
								trigger,
								portalFor,
							})),
					copyButton(h, {
						status: copyStatusOf(model, "meta-json"),
						label: "Log JSON",
						iconSize: 13,
						slot: "tooltip-trigger",
						onClick: Message.ClickedCopy({ copyId: "meta-json", text: buildLogJsonPayload(log) }),
						attributes: trigger(triggerIdOf(model, "json")),
					}),
					...portalFor(triggerIdOf(model, "json")),
				],
			),
		],
	)

/** "Open in full page" and the permalink copy, where the app has a page for one log. */
const logPageControls = (
	h: H,
	model: Model,
	log: LogRecord,
	logPagePath: string,
	showOpenFullPage: boolean,
	{ trigger, portalFor }: TooltipParts,
): ReadonlyArray<Html> => {
	const path = `${logPagePath}${encodeLogKey(log)}`
	return [
		...(showOpenFullPage
			? [
					linkButton(
						h,
						{
							size: "icon-xs",
							variant: "ghost",
							className: "text-muted-foreground",
							slot: "icon-button",
							href: path,
							attributes: [
								h.AriaLabel("Open in full page"),
								...trigger(triggerIdOf(model, "page")),
							],
						},
						[icon(h, "ExternalLinkIcon")],
					),
					...portalFor(triggerIdOf(model, "page")),
				]
			: []),
		copyButton(h, {
			status: copyStatusOf(model, "meta-link"),
			label: "Link to log",
			idleIcon: "LinkIcon",
			iconSize: 13,
			slot: "tooltip-trigger",
			onClick: Message.ClickedCopyPermalink({ copyId: "meta-link", path }),
			attributes: trigger(triggerIdOf(model, "link")),
		}),
		...portalFor(triggerIdOf(model, "link")),
	]
}
