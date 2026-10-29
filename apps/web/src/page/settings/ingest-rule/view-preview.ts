import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { alert, alertDescription } from "../../../ui/alert"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { nativeOption, nativeSelect } from "../../../ui/native-select"
import { panel, panelHeader } from "../../../ui/panel"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton } from "../../../ui/skeleton"
import { draftProblems, specOf } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import {
	type PreviewRow,
	type PreviewSignal,
	recordsOf,
	runPreview,
	segmentsOf,
	type ValueChange,
} from "./preview"
import type { H } from "./view-form"

// The right column: the draft run over recent records, plus the callouts that apply.

const MAX_ROWS = 20

const percent = (part: number, total: number) =>
	total === 0 ? "0%" : `${Math.round((part / total) * 1000) / 10}%`

const highlighted = (h: H, value: string): Html =>
	h.span(
		[h.Class("break-all")],
		segmentsOf(value).map((segment) =>
			segment.isReplacement
				? h.mark([h.Class("bg-severity-info/15 text-foreground rounded-sm px-0.5")], [segment.text])
				: segment.text,
		),
	)

const changeLine = (h: H, change: ValueChange): Html =>
	h.div(
		[h.Class("flex flex-col gap-0.5 font-mono text-2xs")],
		[
			h.span(
				[h.Class("text-muted-foreground")],
				[change.where === "body" ? "body" : `${change.where} ${change.key}`],
			),
			h.span(
				[h.Class("text-muted-foreground line-through decoration-muted-foreground/50 break-all")],
				[change.before],
			),
			change.after === null
				? h.span([h.Class("text-severity-warn")], ["removed"])
				: highlighted(h, change.after),
		],
	)

const recordLabel = (row: PreviewRow): string => {
	const record = row.record
	const service = typeof record.resource["service.name"] === "string" ? record.resource["service.name"] : ""
	const what =
		record.signal === "logs" ? (typeof record.body === "string" ? record.body : "") : (record.name ?? "")
	return [service, what].filter((part) => part !== "").join(" · ")
}

const previewRow = (h: H, row: PreviewRow, index: number): Html =>
	h.li(
		[h.Key(String(index)), h.Class("flex flex-col gap-1.5 border-t px-4 py-2.5 first:border-t-0")],
		[
			h.div(
				[h.Class("flex min-w-0 items-center gap-2")],
				[
					badge(h, { variant: row._tag === "dropped" ? "warn" : "info", size: "sm" }, [
						row._tag === "dropped" ? "Drop" : "Redact",
					]),
					h.span([h.Class("truncate text-xs")], [recordLabel(row)]),
				],
			),
			...(row._tag === "redacted" ? row.changes.map((change) => changeLine(h, change)) : []),
		],
	)

const headline = (h: H, result: ReturnType<typeof runPreview>, isDrop: boolean): Html =>
	h.p(
		[h.Class("text-sm font-medium")],
		[
			isDrop
				? `Would drop ${result.dropped} of ${result.total} (${percent(result.dropped, result.total)})`
				: `Would redact ${result.redacted} of ${result.total} (${percent(result.redacted, result.total)})`,
		],
	)

const body = (h: H, model: Model): Html => {
	if (!model.draft.signals.includes("logs") && !model.draft.signals.includes("traces"))
		return h.p(
			[h.Class("text-muted-foreground px-4 py-3 text-sm")],
			["The preview covers logs and traces."],
		)
	return AsyncData.matchData(model.samples, {
		onEmpty: () =>
			h.div(
				[h.Class("flex flex-col gap-2 px-4 py-3")],
				[skeleton(h, "h-4 w-40"), skeleton(h, "h-24 w-full")],
			),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load recent data",
				onRetry: Message.ClickedRetryPreview(),
				className: "border-0",
			}),
		onData: (samples) => {
			const records = recordsOf(samples)
			if (records.length === 0)
				return h.p(
					[h.Class("text-muted-foreground px-4 py-3 text-sm")],
					["No records in the last hour to preview."],
				)
			if (draftProblems(model.draft).filter((problem) => problem !== "give the rule a name").length > 0)
				return h.p(
					[h.Class("text-muted-foreground px-4 py-3 text-sm")],
					["Fix the rule to see its effect."],
				)
			const result = runPreview(specOf(model.draft), records)
			const isHash = model.draft.actionType === "redact" && model.draft.method === "hash"
			return h.div(
				[],
				[
					h.div(
						[h.Class("flex flex-col gap-1 px-4 py-3")],
						[
							headline(h, result, model.draft.actionType === "drop"),
							h.p(
								[h.Class("text-muted-foreground text-xs")],
								[
									`Most recent ${result.total} records, last hour.${isHash ? " Preview hash, differs from stored." : ""}`,
								],
							),
						],
					),
					result.rows.length === 0
						? h.p(
								[h.Class("text-muted-foreground border-t px-4 py-3 text-sm")],
								["Nothing in the sample matches."],
							)
						: h.ul(
								[h.AriaLabel("Preview"), h.Class("border-t")],
								result.rows.slice(0, MAX_ROWS).map((row, index) => previewRow(h, row, index)),
							),
				],
			)
		},
	})
}

const controls = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2 border-b px-4 py-2.5")],
		[
			segmentedSelect<PreviewSignal, Message>(h, {
				size: "xs",
				ariaLabel: "Preview signal",
				value: model.previewSignal,
				onChange: (signal) => Message.PickedPreviewSignal({ signal }),
				options: [
					{ value: "logs", label: "Logs", isDisabled: !model.draft.signals.includes("logs") },
					{ value: "traces", label: "Traces", isDisabled: !model.draft.signals.includes("traces") },
				],
			}),
			nativeSelect(
				h,
				{
					defaultValue: model.previewService,
					size: "sm",
					attributes: [
						h.AriaLabel("Preview service"),
						h.OnChange((service) => Message.PickedPreviewService({ service })),
					],
				},
				[
					nativeOption("", "All services"),
					...model.services.map((service) => nativeOption(service, service)),
				],
			),
		],
	)

const callout = (h: H, text: string, variant: "info" | "warn" = "info"): Html =>
	alert(h, { variant, size: "sm" }, [
		icon(h, variant === "warn" ? "CircleWarningIcon" : "CircleInfoIcon"),
		alertDescription(h, [text]),
	])

export const callouts = (h: H, model: Model): ReadonlyArray<Html> => [
	callout(h, "Applies to new data within 30 seconds. Data already stored is unchanged."),
	...(model.draft.actionType === "drop" && model.draft.signals.includes("traces")
		? [callout(h, "Dropped spans are missing from service metrics and the service map.", "warn")]
		: []),
	...(model.draft.actionType === "redact" && model.draft.method === "hash"
		? [
				callout(
					h,
					"Hashing is pseudonymization: values with few possibilities, like phone numbers, can be guessed.",
					"warn",
				),
			]
		: []),
	...(model.draft.actionType === "redact" && model.draft.scopes.includes("events")
		? [
				callout(
					h,
					"The preview sample carries no span events, so redactions there only show in stored data.",
				),
			]
		: []),
]

export const previewPanel = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex flex-col gap-3")],
		[
			panel(h, { className: cn("overflow-hidden") }, [
				panelHeader(h, { title: "Preview" }),
				controls(h, model),
				body(h, model),
			]),
			...callouts(h, model),
		],
	)
