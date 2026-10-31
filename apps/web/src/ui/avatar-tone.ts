// Warm tiles for initials avatars, near the primary orange, so an org or a user without an image
// gets the same colour wherever their avatar is drawn.
const WARM_TONES: readonly [string, ...string[]] = [
	"bg-avatar-1 text-primary-foreground",
	"bg-avatar-2 text-primary-foreground",
	"bg-avatar-3 text-primary-foreground",
	"bg-avatar-4 text-primary-foreground",
	"bg-avatar-5 text-primary-foreground",
]

/** The tile classes for a seed (an org or user name): stable across renders and pages. */
export const warmAvatarTone = (seed: string): string => {
	const hash = Array.from(seed).reduce((acc, char) => (acc * 31 + (char.codePointAt(0) ?? 0)) >>> 0, 0)
	return WARM_TONES[hash % WARM_TONES.length] ?? WARM_TONES[0]
}
