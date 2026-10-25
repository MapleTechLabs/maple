// Warm tiles for initials avatars, near the primary orange, so an org or a user without an image
// gets the same colour wherever their avatar is drawn.
const WARM_TONES: readonly [string, ...string[]] = [
	"bg-[oklch(0.7_0.15_59)] text-primary-foreground",
	"bg-[oklch(0.76_0.13_80)] text-primary-foreground",
	"bg-[oklch(0.66_0.14_40)] text-primary-foreground",
	"bg-[oklch(0.68_0.1_25)] text-primary-foreground",
	"bg-[oklch(0.72_0.07_65)] text-primary-foreground",
]

/** The tile classes for a seed (an org or user name): stable across renders and pages. */
export const warmAvatarTone = (seed: string): string => {
	const hash = Array.from(seed).reduce((acc, char) => (acc * 31 + (char.codePointAt(0) ?? 0)) >>> 0, 0)
	return WARM_TONES[hash % WARM_TONES.length] ?? WARM_TONES[0]
}
