import { Color } from "three"
import { errorRateLevel } from "@maple/ui/lib/error-rate"
import type { InkPalette } from "./palette"

export { FACE_TONE, type InkPalette, type MachineKind, mapPalette } from "./palette"

/** Mix toward the paper so dimmed parts recede without transparency sorting. */
export function fade(color: string, paper: string, amount: number) {
	return `#${new Color(color).lerp(new Color(paper), amount).getHexString()}`
}

export function beltInk(errorRate: number, palette: InkPalette) {
	const level = errorRateLevel(errorRate)
	return level === "crit" ? "#c8553d" : level === "warn" ? "#d9a21b" : palette.ink
}
