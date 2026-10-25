import { cva } from "class-variance-authority"
import { TONE_FILL } from "../../lib/tone"

export const statusDotVariants = cva("relative inline-flex shrink-0 rounded-full", {
	defaultVariants: { tone: "neutral", size: "default" },
	variants: {
		tone: {
			// The shared status vocabulary (lib/tone), on the same severity tokens the logs page uses.
			crit: TONE_FILL.crit,
			warn: TONE_FILL.warn,
			ok: TONE_FILL.ok,
			info: TONE_FILL.info,
			done: TONE_FILL.done,
			neutral: TONE_FILL.neutral,
			// In-flight work (running investigations, live streams).
			live: "bg-primary",
			// Colour comes from the caller's className (service colours, severity maps).
			custom: "",
		},
		size: {
			sm: "size-1",
			default: "size-1.5",
			lg: "size-2",
		},
	},
})
