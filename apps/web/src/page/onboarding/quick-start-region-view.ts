import { MapleRegion, type MapleRegion as Region } from "@maple/domain/organization-regions"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import { optionCard } from "./option-card"
import { Message, type RegionChoice } from "./quick-start"
import { regionFlag } from "./region-flag"

// `StepRegion`: the first step for an org created without a region. This region continues here; the other
// moves onboarding there.

type H = HtmlBuilder<Message>

const REGION_CARDS = {
	us: {
		name: "United States",
		place: "North America",
		residency: "Data stays in the US",
		accent: "#E5485B",
		check: "border-[#E5485B] bg-[#E5485B] text-white",
	},
	eu: {
		name: "European Union",
		place: "Frankfurt, Germany",
		residency: "Data stays in the EU",
		accent: "#5B7CFF",
		check: "border-[#5B7CFF] bg-[#5B7CFF] text-white",
	},
} as const satisfies Record<Region, { name: string; place: string; residency: string; accent: string; check: string }>

const residency = (h: H, region: Region, isActive: boolean): Html => {
	const card = REGION_CARDS[region]
	return h.span(
		[
			h.Class(
				"inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-2xs font-medium text-muted-foreground",
			),
			...(isActive
				? [h.Style({ color: card.accent, "border-color": `${card.accent}66`, "background-color": `${card.accent}14` })]
				: []),
		],
		[
			h.span([h.AriaHidden(true), h.Class("size-1.5 rounded-full"), h.Style({ "background-color": card.accent })], []),
			card.residency,
		],
	)
}

const regionCard = (h: H, choice: RegionChoice, region: Region): Html => {
	const isActive = choice.selected === region
	const card = REGION_CARDS[region]
	return optionCard(h, {
		type: "radio",
		name: "onboarding-region",
		layout: "stacked",
		isChecked: isActive,
		isDisabled: choice.isSaving,
		onChange: Message.PickedRegion({ region }),
		label: card.name,
		title: card.name,
		description: card.place,
		accent: card.accent,
		checkClassName: card.check,
		media: regionFlag(
			h,
			region,
			cn(
				"h-12 w-18 transition-[opacity,filter] duration-150 motion-reduce:transition-none",
				!isActive && "opacity-70 saturate-50 group-hover:opacity-100 group-hover:saturate-100",
			),
		),
		footer: residency(h, region, isActive),
	})
}

/** `StepRegion`. */
export const regionStep = (h: H, choice: RegionChoice): Html =>
	h.div(
		[h.Class("flex flex-1 flex-col items-center justify-center overflow-auto px-6 py-12")],
		[
			h.div(
				[h.Class("flex w-full max-w-3xl flex-col gap-8")],
				[
					h.div(
						[h.Class("space-y-3 text-center")],
						[
							h.div([h.AriaHidden(true), h.Class("mx-auto mb-6 w-fit text-primary")], [icon(h, "MapleMark", { size: 56 })]),
							eyebrow(h, { variant: "label", className: "text-primary" }, ["Before you start"]),
							h.h1([h.Class("text-3xl font-semibold tracking-tight")], ["Where should your data live?"]),
							h.p(
								[h.Class("mx-auto max-w-md text-sm leading-relaxed text-muted-foreground")],
								[
									"Each region is a separate Maple. Your telemetry, dashboards and alerts are stored and processed only in the one you pick.",
								],
							),
						],
					),
					h.fieldset(
						[h.Class("grid min-w-0 gap-3 sm:grid-cols-2")],
						[h.legend([h.Class("sr-only")], ["Data region"]), ...MapleRegion.literals.map((region) => regionCard(h, choice, region))],
					),
					h.p(
						[
							h.AriaLive("polite"),
							h.AriaAtomic(true),
							h.Class(
								cn(
									"min-h-10 text-center text-xs leading-relaxed",
									choice.errorMessage !== null ? TONE_TEXT.crit : "text-muted-foreground",
								),
							),
						],
						[choice.errorMessage ?? "An organization stays in the region it starts in."],
					),
					h.div(
						[h.Class("flex items-center justify-end")],
						[
							button(
								h,
								{
									size: "lg",
									className: "min-w-[180px]",
									isLoading: choice.isSaving,
									attributes: [h.OnClick(Message.ClickedRegionContinue())],
								},
								["Continue", h.span([h.Class("ml-2")], ["→"])],
							),
						],
					),
				],
			),
		],
	)
