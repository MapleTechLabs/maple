import { Schema } from "effect"
import {
	SESSION_QUALITY_TAGS,
	SESSION_TAG_THRESHOLDS,
	SESSION_TAGS,
	SessionTag,
} from "@maple/domain/query-engine"

const seconds = (ms: number) => `${ms / 1000}s`

export const SESSION_TAG_LABELS = {
	engaged: "Engaged",
	glance: "Glance",
	idle: "Idle tab",
	bounce: "Bounce",
	bot: "Bot",
	signed_in: "Signed in",
	new_visitor: "New visitor",
} satisfies Record<SessionTag, string>

// Built from the thresholds the warehouse applies, so the copy cannot drift from the rule.
export const SESSION_TAG_DESCRIPTIONS = {
	engaged: "Everything that is not a bot, bounce, idle tab or glance",
	glance: `One page, at most ${SESSION_TAG_THRESHOLDS.glanceMaxClicks} clicks, under ${seconds(SESSION_TAG_THRESHOLDS.glanceMaxMs)}`,
	idle: "One page, no clicks, no errors",
	bounce: `Under ${seconds(SESSION_TAG_THRESHOLDS.bounceMaxMs)} with no clicks`,
	bot: "Crawler, headless browser or uptime check",
	signed_in: "Identified with identify()",
	new_visitor: "First visit from this browser",
} satisfies Record<SessionTag, string>

/** Display order: the tier you most likely want first, then the traits. */
export const SESSION_TAG_ORDER: ReadonlyArray<SessionTag> = SESSION_TAGS

const isSessionTag = Schema.is(SessionTag)

/** `name` as a tag, or undefined for anything the vocabulary does not know. */
export const asSessionTag = (name: string): SessionTag | undefined => SESSION_TAGS.find((tag) => tag === name)

/** The valid tags in a URL param; a hand-edited URL cannot send the API an unknown tag. */
export const sessionTagsFromSearch = (
	tags: ReadonlyArray<string> | undefined,
): Array<SessionTag> | undefined => {
	const valid = (tags ?? []).filter(isSessionTag)
	return valid.length > 0 ? valid : undefined
}

const isQualityTier = (tag: SessionTag) => SESSION_QUALITY_TAGS.some((quality) => quality === tag)

/**
 * The selection after a checkbox change. A newly ticked tier drops any other tier,
 * because every session has exactly one and two tiers together match nothing.
 */
export const nextTagSelection = (
	previous: ReadonlyArray<SessionTag>,
	values: ReadonlyArray<string>,
): Array<SessionTag> => {
	const next = sessionTagsFromSearch(values) ?? []
	const addedTier = next.find((tag) => isQualityTier(tag) && !previous.includes(tag))
	return addedTier === undefined ? next : next.filter((tag) => !isQualityTier(tag) || tag === addedTier)
}

/** The quality tier worth flagging on a row: everything but `engaged`. */
export const noiseTierOf = (tags: ReadonlyArray<SessionTag>): SessionTag | undefined =>
	tags.find((tag) => tag !== "engaged" && isQualityTier(tag))
