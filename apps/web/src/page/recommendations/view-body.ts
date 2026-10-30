import type { V2Recommendation } from "@maple/domain/http/v2"
import { formatNumber } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../ui/copy-button"
import { icon } from "../../ui/icon"
import { inlineCode } from "../../ui/inline-code"
import { panel } from "../../ui/panel"
import { Message } from "./message"
import type { Model } from "./model"
import { sectionHeading } from "../kit/section-heading"

// The body of `RecommendationDetailPage`: Summary, ChangeBreakdown, CautionCallout and the fix block.

type H = HtmlBuilder<Message>

export const code = (h: H, value: string | null): Html => inlineCode(h, { variant: "plain" }, [value ?? ""])

export const isApplyable = (issue: V2Recommendation) =>
	issue.kind === "rename" && Boolean(issue.canonical_key)
export const isLive = (issue: V2Recommendation) => issue.status === "applied" || issue.status === "resolved"

const summary = (h: H, issue: V2Recommendation): Html =>
	h.p(
		[h.Class("text-base leading-relaxed text-foreground-soft")],
		issue.kind === "double-emission"
			? [
					"Your spans emit both ",
					code(h, issue.source_key),
					" and",
					" ",
					code(h, issue.canonical_key),
					". Standardize on",
					" ",
					code(h, issue.canonical_key),
					" in your SDK. An ingest mapping can't merge them because the canonical key already exists on your spans.",
				]
			: issue.kind === "naming"
				? [
						code(h, issue.source_key),
						" doesn't follow OpenTelemetry's lowercase ",
						code(h, "dotted.snake_case"),
						" convention. Rename it where your spans are created so it conforms to the semantic conventions.",
					]
				: [
						code(h, issue.source_key),
						" is a deprecated or non-conforming OpenTelemetry attribute key. Maple can rewrite it to",
						" ",
						code(h, issue.canonical_key),
						" at ingest time so newly ingested spans use the current semantic-convention name.",
					],
	)

const LABELS = {
	rename: { from: "Deprecated key on your spans today", to: "Canonical key Maple will write" },
	"double-emission": { from: "Deprecated key, still emitted", to: "Canonical key, already present" },
	naming: { from: "Non-conforming key", to: "" },
} as const

const changeBreakdown = (h: H, issue: V2Recommendation): Html => {
	const labels = LABELS[issue.kind]
	const note =
		issue.kind === "double-emission"
			? "Both keys are already on your spans, so an ingest mapping can't merge them. Standardize on the canonical key in your SDK."
			: issue.kind === "naming"
				? "No confident canonical target. Rename this attribute in your SDK."
				: null
	return h.section(
		[],
		[
			sectionHeading(h, { title: "What changes", variant: "eyebrow" }),
			panel(h, {}, [
				h.div(
					[h.Class("flex items-start gap-3 px-4 py-3")],
					[
						icon(h, "CircleXmarkIcon", {
							size: 16,
							className: "mt-0.5 shrink-0 text-muted-foreground",
						}),
						h.div(
							[h.Class("min-w-0 flex-1")],
							[
								h.p([h.Class("text-xs text-muted-foreground")], [labels.from]),
								h.code(
									[
										h.Class(
											"font-mono text-sm break-all text-foreground line-through decoration-muted-foreground/40",
										),
									],
									[issue.source_key],
								),
							],
						),
						h.span(
							[h.Class("shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground")],
							[formatNumber(issue.usage_count), " spans · 24h"],
						),
					],
				),
				...(issue.canonical_key
					? [
							h.div(
								[h.Class("flex items-start gap-3 border-t border-border-subtle px-4 py-3")],
								[
									icon(h, "CircleCheckIcon", {
										size: 16,
										className: "mt-0.5 shrink-0 text-severity-info",
									}),
									h.div(
										[h.Class("min-w-0 flex-1")],
										[
											h.p([h.Class("text-xs text-muted-foreground")], [labels.to]),
											h.code(
												[h.Class("font-mono text-sm break-all text-foreground")],
												[issue.canonical_key],
											),
										],
									),
								],
							),
						]
					: []),
			]),
			...(note === null
				? []
				: [h.p([h.Class("mt-2 text-xs leading-relaxed text-muted-foreground")], [note])]),
		],
	)
}

const cautionCallout = (h: H, issue: V2Recommendation): Html =>
	h.div(
		[h.Class("rounded-r-md border-l-2 border-severity-warn bg-severity-warn/8 px-4 py-3")],
		[
			h.p(
				[h.Class("text-sm leading-relaxed text-foreground-soft")],
				[
					h.span([h.Class("font-medium text-severity-warn")], ["Please note:"]),
					" ",
					...(isApplyable(issue) && issue.canonical_key
						? [
								"Applying creates an ingest mapping that copies",
								" ",
								code(h, issue.source_key),
								" →",
								" ",
								code(h, issue.canonical_key),
								" on newly ingested spans. Existing spans aren't rewritten, and the mapping never overwrites a target that already exists.",
							]
						: [
								"Maple can't resolve this with an ingest mapping. The fix is to rename the attribute at your SDK / instrumentation so spans emit the conforming key.",
							]),
				],
			),
		],
	)

const mappingBlock = (h: H, model: Model, issue: V2Recommendation): Html => {
	const live = isLive(issue)
	const snippet = `WHEN span attribute \`${issue.source_key}\` is present\nCOPY → \`${issue.canonical_key}\``
	return h.section(
		[],
		[
			sectionHeading(h, {
				title: live ? "Active ingest mapping" : "What Apply does",
				variant: "eyebrow",
			}),
			panel(h, { tone: "muted" }, [
				h.div(
					[h.Class("flex items-center justify-between border-b border-border-subtle px-3 py-2")],
					[
						h.span(
							[h.Class("text-xs text-muted-foreground")],
							[live ? "This mapping is live" : "Ingest attribute mapping"],
						),
						// TODO(tooltip): the "Copy" tooltip popup on hover.
						CopyButton.view(h, {
							model: model.copy,
							value: snippet,
							label: "Mapping",
							size: "icon-sm",
							slot: "tooltip-trigger",
							toParentMessage: (message) => Message.GotCopyMessage({ message }),
							attributes: [h.DataAttribute("base-ui-tooltip-trigger", "")],
						}),
					],
				),
				h.div(
					[h.Class("space-y-1.5 px-4 py-3 font-mono text-xs leading-relaxed")],
					[
						h.div(
							[h.Class("flex items-baseline gap-3")],
							[
								h.span([h.Class("w-12 shrink-0 text-muted-foreground")], ["when"]),
								h.span(
									[h.Class("break-all")],
									[
										"span attribute ",
										h.span([h.Class("text-foreground")], [issue.source_key]),
										" is present",
									],
								),
							],
						),
						h.div(
							[h.Class("flex items-baseline gap-3")],
							[
								h.span([h.Class("w-12 shrink-0 text-muted-foreground")], ["copy"]),
								h.span(
									[h.Class("break-all")],
									[
										h.span([h.Class("text-muted-foreground")], ["→"]),
										" ",
										h.span([h.Class("text-severity-info")], [issue.canonical_key ?? ""]),
									],
								),
							],
						),
					],
				),
			]),
		],
	)
}

const sdkFixBlock = (h: H, issue: V2Recommendation): Html =>
	h.section(
		[],
		[
			sectionHeading(h, { title: "How to fix", variant: "eyebrow" }),
			panel(h, { tone: "muted", className: "px-4 py-3" }, [
				h.p(
					[h.Class("text-sm leading-relaxed text-muted-foreground")],
					[
						"Rename ",
						code(h, issue.source_key),
						...(issue.canonical_key
							? [" ", "to ", code(h, issue.canonical_key)]
							: [" to a lowercase, dotted semantic-convention key"]),
						" ",
						"where your spans are created (the instrumentation / SDK). Once the conforming key appears on incoming spans, this recommendation resolves automatically.",
					],
				),
			]),
		],
	)

export const body = (h: H, model: Model, issue: V2Recommendation): ReadonlyArray<Html> => [
	summary(h, issue),
	changeBreakdown(h, issue),
	cautionCallout(h, issue),
	isApplyable(issue) && issue.canonical_key ? mappingBlock(h, model, issue) : sdkFixBlock(h, issue),
]
