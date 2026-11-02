// `toneBoxClass`: a box (badge, pill, chip) tinted in one tone: its `-a2` fill, `-a3` edge and the
// tone's text, for an element whose shape another kit piece draws.

export type ToneBoxTone = "info" | "error" | "primary"

const TONE_BOX = {
	info: "bg-severity-info-a2 border-severity-info-a3 text-severity-info",
	error: "bg-severity-error-a2 border-severity-error-a3 text-severity-error",
	primary: "bg-primary-a2 border-primary-a3 text-primary",
} as const satisfies Record<ToneBoxTone, string>

export const toneBoxClass = (tone: ToneBoxTone): string => TONE_BOX[tone]
