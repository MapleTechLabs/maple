import { MapleRegion, type MapleRegion as Region } from "@maple/domain/organization-regions"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { heading } from "../../ui/heading"
import { icon } from "../../ui/icon"
import { optionCard } from "./option-card"
import { Message, type RegionChoice } from "./quick-start"
import { regionFlag } from "./region-flag"

// `StepRegion`: the first step for an org created without a region. This region continues here; the other
// moves onboarding there.

type H = HtmlBuilder<Message>

export const REGION_CARDS = {
	us: {
		name: "United States",
		place: "North America",
		residency: "Data stays in the US",
		dot: "bg-region-us",
	},
	eu: {
		name: "European Union",
		place: "Frankfurt, Germany",
		residency: "Data stays in the EU",
		dot: "bg-region-eu",
	},
} as const satisfies Record<Region, { name: string; place: string; residency: string; dot: string }>

/** The residency line, its dot in the region's map colour. */
const residency = (h: H, region: Region): Html =>
	h.span(
		[h.Class("inline-flex items-center gap-1.5 text-xs text-muted-foreground")],
		[
			h.span([h.AriaHidden(true), h.Class(cn("size-1.5 rounded-full", REGION_CARDS[region].dot))], []),
			REGION_CARDS[region].residency,
		],
	)

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
		media: regionFlag(
			h,
			region,
			cn(
				"h-12 w-18 transition-[opacity,filter] duration-150 motion-reduce:transition-none",
				!isActive && "opacity-70 saturate-50 group-hover:opacity-100 group-hover:saturate-100",
			),
		),
		footer: residency(h, region),
	})
}

/** `StepRegion`. */
export const regionStep = (h: H, choice: RegionChoice): Html =>
	h.div(
		[h.Class("flex flex-1 flex-col items-center justify-center px-6 pb-12 pt-4 sm:px-12")],
		[
			h.div(
				[h.Class("flex w-full max-w-3xl flex-col gap-8")],
				[
					h.div(
						[h.Class("flex flex-col items-center gap-2.5 text-center")],
						[
							heading(h, { level: 1, variant: "display" }, ["Where should your data live?"]),
							h.p(
								[h.Class("max-w-md text-title leading-relaxed text-muted-foreground")],
								[
									"Each region is a separate Maple. Your telemetry, dashboards and alerts are stored and processed only in the one you pick.",
								],
							),
						],
					),
					h.fieldset(
						[h.Class("grid min-w-0 gap-3 sm:grid-cols-2")],
						[
							h.legend([h.Class("sr-only")], ["Data region"]),
							...MapleRegion.literals.map((region) => regionCard(h, choice, region)),
						],
					),
					h.p(
						[
							h.AriaLive("polite"),
							h.AriaAtomic(true),
							h.Class(
								cn(
									"min-h-5 text-center text-xs leading-relaxed",
									choice.errorMessage !== null ? TONE_TEXT.crit : "text-muted-foreground",
								),
							),
						],
						[choice.errorMessage ?? "An organization stays in the region it starts in."],
					),
					h.div(
						[h.Class("flex justify-center")],
						[
							button(
								h,
								{
									size: "lg",
									className: "min-w-44",
									isLoading: choice.isSaving,
									attributes: [h.OnClick(Message.ClickedRegionContinue())],
								},
								["Continue", icon(h, "ArrowRightIcon", { size: 16 })],
							),
						],
					),
				],
			),
		],
	)
