/**
 * Delta and palette helpers shared by the email renderers. Markup-free: each
 * renderer feeds the parts into its own compiled fragments.
 */
import { deltaArrow, fmtDeltaAbs, type Delta } from "./weekly-digest-core"

export const C = {
	fgMuted: "#8a7f72",
	fgDim: "#5c554c",
	orange: "#e8872a",
	green: "#4aa865",
	red: "#e85d4a",
	amber: "#e8a02a",
	borderSubtle: "#302b26",
}

/**
 * Arrow + text for one delta. `new`/`gone`/`none` carry no percentage, so they
 * render as a word rather than a number — the whole point of the `Delta` union
 * is that "no traffic last week" must never come out as `↑ 100.0%`.
 */
export function deltaParts(
	delta: Delta,
	invertColor: boolean,
): { arrow: string; value: string; good: boolean | null } {
	switch (delta.kind) {
		case "pct": {
			if (Math.abs(delta.value) < 0.05)
				return { arrow: deltaArrow(0), value: fmtDeltaAbs(0), good: null }
			const isPositive = delta.value > 0
			return {
				arrow: deltaArrow(delta.value),
				value: fmtDeltaAbs(delta.value),
				good: invertColor ? !isPositive : isPositive,
			}
		}
		case "new":
			return { arrow: "", value: "new", good: invertColor ? false : true }
		case "gone":
			return { arrow: "", value: "none this week", good: invertColor ? true : false }
		case "none":
			return { arrow: "", value: "—", good: null }
	}
}

/** Pill colours for a delta: muted when flat or unquantified. */
export function deltaPalette(delta: Delta, invertColor = false): { color: string; bg: string } {
	const { good } = deltaParts(delta, invertColor)
	if (good === null) return { color: C.fgMuted, bg: "rgba(138,127,114,0.14)" }
	return good
		? { color: C.green, bg: "rgba(74,168,101,0.15)" }
		: { color: C.red, bg: "rgba(232,93,74,0.15)" }
}

/** Dim when flat or unquantified, otherwise the direction's colour. */
export function trendColor(delta: Delta): string {
	if (delta.kind === "none") return C.fgDim
	if (delta.kind === "new") return C.green
	if (delta.kind === "gone") return C.red
	if (Math.abs(delta.value) < 0.05) return C.fgDim
	return delta.value > 0 ? C.green : C.red
}

export function rowBorder(index: number, total: number): string {
	return index < total - 1 ? `1px solid ${C.borderSubtle}` : "none"
}
