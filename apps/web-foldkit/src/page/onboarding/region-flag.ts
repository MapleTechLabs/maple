import type { MapleRegion } from "@maple/domain/organization-regions"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// `RegionFlag`: both flags on one 3:2 box.

const W = 60
const H = 40

const REGION_FLAG_COLORS = {
	us: { primary: "#B22234", secondary: "#3C3B6E" },
	eu: { primary: "#003399", secondary: "#FFCC00" },
} as const satisfies Record<MapleRegion, { primary: string; secondary: string }>

const US_STRIPE = H / 13
const US_CANTON_W = W * 0.4
const US_CANTON_H = US_STRIPE * 7
const US_STARS = Array.from({ length: 9 }, (_, row) =>
	Array.from({ length: row % 2 === 0 ? 6 : 5 }, (_, col) => ({
		cx: (row % 2 === 0 ? 2 : 4) * (US_CANTON_W / 24) + col * 4 * (US_CANTON_W / 24),
		cy: (row + 1) * (US_CANTON_H / 10),
	})),
).flat()

const EU_STAR_POINTS = (() => {
	const outer = H / 18
	const inner = outer * 0.382
	return Array.from({ length: 10 }, (_, i) => {
		const angle = -Math.PI / 2 + (i * Math.PI) / 5
		const radius = i % 2 === 0 ? outer : inner
		return `${(radius * Math.cos(angle)).toFixed(3)},${(radius * Math.sin(angle)).toFixed(3)}`
	}).join(" ")
})()
const EU_STARS = Array.from({ length: 12 }, (_, i) => {
	const angle = (i * Math.PI) / 6
	return { x: W / 2 + (H / 3) * Math.sin(angle), y: H / 2 - (H / 3) * Math.cos(angle) }
})

const usFlag = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => {
	const { primary, secondary } = REGION_FLAG_COLORS.us
	return [
		h.rect([h.Attribute("width", String(W)), h.Attribute("height", String(H)), h.Attribute("fill", "#FFFFFF")], []),
		...Array.from({ length: 7 }, (_, i) =>
			h.rect(
				[
					h.Attribute("y", String(i * 2 * US_STRIPE)),
					h.Attribute("width", String(W)),
					h.Attribute("height", String(US_STRIPE)),
					h.Attribute("fill", primary),
				],
				[],
			),
		),
		h.rect([h.Attribute("width", String(US_CANTON_W)), h.Attribute("height", String(US_CANTON_H)), h.Attribute("fill", secondary)], []),
		...US_STARS.map((star) =>
			h.circle(
				[h.Attribute("cx", String(star.cx)), h.Attribute("cy", String(star.cy)), h.Attribute("r", "0.55"), h.Attribute("fill", "#FFFFFF")],
				[],
			),
		),
	]
}

const euFlag = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => {
	const { primary, secondary } = REGION_FLAG_COLORS.eu
	return [
		h.rect([h.Attribute("width", String(W)), h.Attribute("height", String(H)), h.Attribute("fill", primary)], []),
		...EU_STARS.map((star) =>
			h.polygon(
				[
					h.Attribute("points", EU_STAR_POINTS),
					h.Attribute("transform", `translate(${star.x} ${star.y})`),
					h.Attribute("fill", secondary),
				],
				[],
			),
		),
	]
}

/** The region's flag, rounded and outlined so it sits on dark surfaces. */
export const regionFlag = <M>(h: HtmlBuilder<M>, region: MapleRegion, className?: string): Html => {
	const clipId = `region-flag-${region}`
	return h.svg(
		[
			h.Attribute("viewBox", `0 0 ${W} ${H}`),
			h.Role("img"),
			h.AriaLabel(region === "eu" ? "Flag of the European Union" : "Flag of the United States"),
			h.Class(cn("h-8 w-12 shrink-0", className)),
		],
		[
			h.defs(
				[],
				[
					h.clipPath(
						[h.Id(clipId)],
						[h.rect([h.Attribute("width", String(W)), h.Attribute("height", String(H)), h.Attribute("rx", "4")], [])],
					),
				],
			),
			h.g([h.Attribute("clip-path", `url(#${clipId})`)], region === "eu" ? euFlag(h) : usFlag(h)),
			h.rect(
				[
					h.Attribute("x", "0.5"),
					h.Attribute("y", "0.5"),
					h.Attribute("width", String(W - 1)),
					h.Attribute("height", String(H - 1)),
					h.Attribute("rx", "3.5"),
					h.Attribute("fill", "none"),
					h.Attribute("stroke", "#FFFFFF"),
					h.Attribute("stroke-opacity", "0.14"),
				],
				[],
			),
		],
	)
}
