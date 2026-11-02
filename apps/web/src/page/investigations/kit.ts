import type { V2Investigation } from "@maple/domain/http/v2"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { TONE_FILL, TONE_SOFT, TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { investigationKindKey, type InvestigationKindKey } from "@maple/web-data/investigations/display"
import type { Html, HtmlBuilder } from "foldkit/html"
import { bareInput } from "../../ui/bare-input"
import { button } from "../../ui/button"
import { badge } from "../../ui/display"
import { icon, type IconName } from "../../ui/icon"

// The investigation status badge and confidence meter.

type InvestigationStatus = V2Investigation["status"]
type Confidence = NonNullable<V2Investigation["confidence"]>

export const STATUS = {
	investigating: { label: "In progress", tone: TONE_SOFT.live },
	diagnosed: { label: "Diagnosed", tone: TONE_SOFT.ok },
	inconclusive: { label: "Inconclusive", tone: TONE_SOFT.warn },
	resolved: { label: "Resolved", tone: TONE_SOFT.done },
	failed: { label: "Failed", tone: TONE_SOFT.crit },
} as const satisfies Record<InvestigationStatus, { label: string; tone: string }>

/** `InvestigationStatusBadge`. */
export const statusBadge = <M>(h: HtmlBuilder<M>, status: InvestigationStatus, className?: string): Html =>
	badge(h, { variant: "outline", className: cn(STATUS[status].tone, className) }, [STATUS[status].label])

export const ORIGIN = { user: "Manual", system: "Automatic" } as const satisfies Record<
	V2Investigation["seeded_by"],
	string
>

export const KIND_LABEL = {
	alert: "Alert",
	anomaly: "Anomaly",
	error: "Error",
	question: "Question",
	verification: "Fix check",
} as const satisfies Record<InvestigationKindKey, string>

const KIND_ICON = {
	alert: "BellIcon",
	anomaly: "PulseIcon",
	error: "CircleWarningIcon",
	question: "CircleQuestionIcon",
	verification: "MagnifierCheckIcon",
} as const satisfies Record<InvestigationKindKey, IconName>

export const investigationKindLabel = (subject: V2Investigation["subject"]): string =>
	KIND_LABEL[investigationKindKey(subject)]

/** `InvestigationKindMarker`: kind, and the user glyph when a person started it. */
export const kindMarker = <M>(
	h: HtmlBuilder<M>,
	subject: V2Investigation["subject"],
	seededBy: V2Investigation["seeded_by"],
	className?: string,
): Html => {
	const kind = investigationKindKey(subject)
	const label = `${KIND_LABEL[kind]} · started ${seededBy === "user" ? "manually" : "automatically"}`
	return h.span(
		[h.Class(cn("flex shrink-0 items-center gap-1 text-muted-foreground", className)), h.Title(label)],
		[
			h.span([h.Class("sr-only")], [label]),
			icon(h, KIND_ICON[kind], { className: "size-3.5" }),
			...(seededBy === "user" ? [icon(h, "UserIcon", { className: "size-3" })] : []),
		],
	)
}

const CONFIDENCE_TONE_OF = { high: "ok", medium: "warn", low: "neutral" } as const satisfies Record<
	Confidence,
	Tone
>

export const CONFIDENCE_TONE = {
	high: TONE_TEXT.info,
	medium: TONE_TEXT[CONFIDENCE_TONE_OF.medium],
	low: TONE_TEXT[CONFIDENCE_TONE_OF.low],
} as const satisfies Record<Confidence, string>

const FILLED = { high: 3, medium: 2, low: 1 } as const satisfies Record<Confidence, number>
const BAR_HEIGHT = ["h-1.5", "h-2", "h-2.5"] as const

/** `ConfidenceMeter`: ascending bars and the word. */
export const confidenceMeter = <M>(
	h: HtmlBuilder<M>,
	confidence: Confidence | null,
	className?: string,
): Html => {
	if (confidence === null)
		return h.span(
			[h.Class(cn("text-xs text-foreground-subtle", className)), h.Title("No diagnosis yet")],
			[EMPTY_VALUE],
		)
	const filled = FILLED[confidence]
	return h.span(
		[
			h.Class(cn("inline-flex items-center gap-1.5", className)),
			h.Title(`Diagnosis confidence: ${confidence}`),
		],
		[
			h.span(
				[h.Class("flex items-end gap-px"), h.AriaHidden(true)],
				BAR_HEIGHT.map((height, index) =>
					h.span([
						h.Key(height),
						h.Class(
							cn(
								"w-[3px] rounded-2xs",
								height,
								index < filled ? TONE_FILL[CONFIDENCE_TONE_OF[confidence]] : "bg-border",
							),
						),
					]),
				),
			),
			h.span([h.Class(cn("text-xs capitalize", CONFIDENCE_TONE[confidence]))], [confidence]),
		],
	)
}

/** `InvestigateBar`: one field, one verb; `accent` on the first-run hero. */
export const investigateBar = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		value: string
		onInput: (value: string) => M
		onSubmit: M
		isBusy: boolean
		isAccent?: boolean
		placeholder?: string
	}>,
): Html =>
	h.form(
		[
			h.Class(
				cn(
					"flex h-10 items-center gap-3 rounded-lg border bg-card px-3.5 transition-colors focus-within:border-ring",
					options.isAccent === true ? "border-primary-a4" : "border-input",
				),
			),
			h.OnSubmit(options.onSubmit),
		],
		[
			icon(h, "ChatBubbleSparkleIcon", { size: 14, className: "shrink-0 text-primary" }),
			bareInput(h, {
				className: "flex-1 font-prose text-sm text-foreground placeholder:text-muted-foreground",
				attributes: [
					h.Value(options.value),
					h.OnInput(options.onInput),
					h.Placeholder(
						options.placeholder ?? "Ask Maple to investigate a service, a symptom or a question",
					),
					h.AriaLabel("What should Maple investigate?"),
				],
			}),
			button(
				h,
				{
					type: "submit",
					size: "sm",
					// Primary once there is something to send, so an actionable button never reads as disabled.
					variant:
						options.isAccent === true || options.value.trim() !== "" ? "default" : "secondary",
					className: "h-6.5 shrink-0 px-3 text-xs",
					isLoading: options.isBusy,
					isDisabled: options.value.trim() === "",
				},
				["Investigate"],
			),
		],
	)
