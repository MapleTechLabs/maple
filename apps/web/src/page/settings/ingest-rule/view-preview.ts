import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { alert, alertDescription } from "@maple/views/ui/alert"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
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
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The right column: the draft run over recent records, plus the callouts that apply.

const MAX_ROWS = 20

const percent = (part: number, total: number) =>
	total === 0 ? "0%" : `${Math.round((part / total) * 1000) / 10}%`

const highlighted = (h: H, value: string): Html =>
	h.span(
		[h.Class("break-all")],
		Arr.map(segmentsOf(value), (segment) =>
			segment.isReplacement
				? h.mark([h.Class("bg-severity-info-a2 text-foreground rounded-sm px-0.5")], [segment.text])
				: segment.text,
		),
	)

const changeLine = (h: H, change: ValueChange): Html =>
	vstack(h, { gap: "0.5", className: "font-mono text-2xs" }, [
		typography(h, { tone: "muted" }, [
			change.where === "body" ? "body" : `${change.where} ${change.key}`,
		]),
		h.span(
			[h.Class("text-muted-foreground line-through decoration-muted-foreground/50 break-all")],
			[change.before],
		),
		change.after === null
			? typography(h, { tone: "warning" }, ["removed"])
			: highlighted(h, change.after),
	])

const recordLabel = (row: PreviewRow): string => {
	const record = row.record
	const service = typeof record.resource["service.name"] === "string" ? record.resource["service.name"] : ""
	const what =
		record.signal === "logs" ? (typeof record.body === "string" ? record.body : "") : (record.name ?? "")
	return Arr.join(
		Arr.filter([service, what], (part) => part !== ""),
		" · ",
	)
}

const previewRow = (h: H, row: PreviewRow, index: number): Html =>
	vstack(
		h,
		{
			gap: "1.5",
			as: "li",
			className: "border-t px-4 py-2.5 first:border-t-0",
			attributes: [h.Key(String(index))],
		},
		[
			hstack(h, { gap: "2", shrink: true }, [
				badge(h, { variant: row._tag === "dropped" ? "warn" : "info", size: "sm" }, [
					row._tag === "dropped" ? "Drop" : "Redact",
				]),
				typography(h, { size: "xs", truncate: true }, [recordLabel(row)]),
			]),
			...(row._tag === "redacted" ? Arr.map(row.changes, (change) => changeLine(h, change)) : []),
		],
	)

const headline = (h: H, result: ReturnType<typeof runPreview>, isDrop: boolean): Html =>
	typography(h, { size: "sm", weight: "medium", as: "p" }, [
		isDrop
			? `Would drop ${result.dropped} of ${result.total} (${percent(result.dropped, result.total)})`
			: `Would redact ${result.redacted} of ${result.total} (${percent(result.redacted, result.total)})`,
	])

const body = (h: H, model: Model): Html => {
	if (!model.draft.signals.includes("logs") && !model.draft.signals.includes("traces"))
		return typography(h, { size: "sm", tone: "muted", as: "p", className: "px-4 py-3" }, [
			"The preview covers logs and traces.",
		])
	return AsyncData.matchData(model.samples, {
		onEmpty: () =>
			vstack(h, { gap: "2", className: "px-4 py-3" }, [
				skeleton(h, "h-4 w-40"),
				skeleton(h, "h-24 w-full"),
			]),
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
				return typography(h, { size: "sm", tone: "muted", as: "p", className: "px-4 py-3" }, [
					"No records in the last hour to preview.",
				])
			if (
				Arr.filter(draftProblems(model.draft), (problem) => problem !== "give the rule a name")
					.length > 0
			)
				return typography(h, { size: "sm", tone: "muted", as: "p", className: "px-4 py-3" }, [
					"Fix the rule to see its effect.",
				])
			const result = runPreview(specOf(model.draft), records)
			const isHash = model.draft.actionType === "redact" && model.draft.method === "hash"
			return h.div(
				[],
				[
					vstack(h, { gap: "1", className: "px-4 py-3" }, [
						headline(h, result, model.draft.actionType === "drop"),
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							`Most recent ${result.total} records, last hour.${isHash ? " Preview hash, differs from stored." : ""}`,
						]),
					]),
					result.rows.length === 0
						? h.p(
								[h.Class("text-muted-foreground border-t px-4 py-3 text-sm")],
								["Nothing in the sample matches."],
							)
						: h.ul(
								[h.AriaLabel("Preview"), h.Class("border-t")],
								Arr.map(result.rows.slice(0, MAX_ROWS), (row, index) =>
									previewRow(h, row, index),
								),
							),
				],
			)
		},
	})
}

const controls = (h: H, model: Model): Html =>
	hstack(h, { gap: "2", align: "center", wrap: true, className: "border-b px-4 py-2.5" }, [
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
				...Arr.map(model.services, (service) => nativeOption(service, service)),
			],
		),
	])

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
	vstack(h, { gap: "3" }, [
		panel(h, { className: cn("overflow-hidden") }, [
			panelHeader(h, { title: "Preview" }),
			controls(h, model),
			body(h, model),
		]),
		...callouts(h, model),
	])
