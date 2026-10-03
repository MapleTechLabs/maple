import { Schema } from "effect"

/**
 * How much of a person a browser session holds, first match wins: a bot, then a
 * bounce, an idle single page, a glance, and otherwise an engaged visit. Exactly
 * one per session, so "hide the noise" is the single filter `engaged`.
 */
export const SESSION_QUALITY_TAGS = ["bot", "bounce", "idle", "glance", "engaged"] as const

/** Every tag a session can carry: its quality plus independent traits. */
export const SESSION_TAGS = [...SESSION_QUALITY_TAGS, "signed_in", "new_visitor"] as const
export const SessionTag = Schema.Literals(SESSION_TAGS)
export type SessionTag = typeof SessionTag.Type

/** The quality cutoffs. Measured on real traffic: these four tiers were 72% of sessions. */
export const SESSION_TAG_THRESHOLDS = {
	/** Under this with no clicks is a bounce. */
	bounceMaxMs: 5_000,
	/** One page, at most `glanceMaxClicks` clicks, no errors, under this is a glance. */
	glanceMaxMs: 30_000,
	glanceMaxClicks: 2,
} as const

/** A list row's tags, from the columns `sessionReplaysListQuery` returns. */
export const sessionTagsOf = (row: {
	readonly quality: string
	readonly userId: string
	readonly visitorIsNew: number | string
}): Array<SessionTag> => {
	const tags: Array<SessionTag> = []
	const quality = SESSION_QUALITY_TAGS.find((tag) => tag === row.quality)
	if (quality !== undefined) tags.push(quality)
	if (row.userId !== "") tags.push("signed_in")
	if (Number(row.visitorIsNew) === 1) tags.push("new_visitor")
	return tags
}
