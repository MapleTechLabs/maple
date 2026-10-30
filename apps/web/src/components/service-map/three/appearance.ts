import { Color } from "three"
import { errorRateLevel } from "@maple/ui/lib/error-rate"
import type { InkPalette } from "./palette"

export { FACE_TONE, type InkPalette, type MachineKind, mapPalette } from "./palette"

/** Mix toward the paper so dimmed parts recede without transparency sorting. */
export function fade(color: string, paper: string, amount: number) {
	return `#${new Color(color).lerp(new Color(paper), amount).getHexString()}`
}

/** A part outside the selection: drained of colour, then most of the way to the paper, so it
 * recedes in both themes without transparency sorting. */
export function dim(color: string, paper: string, amount: number) {
	const tone = new Color(color)
	const hsl = tone.getHSL({ h: 0, s: 0, l: 0 })
	tone.setHSL(hsl.h, hsl.s * 0.3, hsl.l)
	return `#${tone.lerp(new Color(paper), amount).getHexString()}`
}

/** Less chroma, a little toward the paper: scenery sits a step behind the services. */
function mute(color: string, paper: string) {
	const tone = new Color(color)
	const hsl = tone.getHSL({ h: 0, s: 0, l: 0 })
	tone.setHSL(hsl.h, hsl.s * 0.75, hsl.l)
	return `#${tone.lerp(new Color(paper), 0.14).getHexString()}`
}

/** The palette the forest, meadow and critters draw with: lighter ink, muted colour.
 * Lamplight and the paper stay as they are. */
export function sceneryPalette(palette: InkPalette): InkPalette {
	const m = (color: string) => mute(color, palette.paper)
	return {
		...palette,
		face: m(palette.face),
		plinth: m(palette.plinth),
		pad: m(palette.pad),
		ink: fade(palette.ink, palette.paper, 0.4),
		belt: m(palette.belt),
		kraft: m(palette.kraft),
		tape: m(palette.tape),
		gifts: palette.gifts.map(m),
		foliage: palette.foliage.map(m),
		evergreen: m(palette.evergreen),
		stone: m(palette.stone),
		iron: m(palette.iron),
		soil: m(palette.soil),
		birch: m(palette.birch),
		water: m(palette.water),
		trunk: m(palette.trunk),
		cloud: m(palette.cloud),
	}
}

export function beltInk(errorRate: number, palette: InkPalette) {
	const level = errorRateLevel(errorRate)
	return level === "crit" ? "#c8553d" : level === "warn" ? "#d9a21b" : palette.ink
}
