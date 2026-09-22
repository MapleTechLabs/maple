/**
 * The workspace setting every connector shares, as opposed to the ones a platform defines for
 * itself.
 *
 * There is one, and it is core rather than per-connector because the question it answers is the
 * same wherever a bot is installed: which channels is it active in? Platforms install a bot
 * workspace-wide, so being *installed* says nothing about where it belongs — and a per-connector
 * copy of this would be a rule the host cannot rely on. The check below runs on every mention
 * regardless of what a connector declared, so a connector that never offers the field is silent
 * rather than unrestricted.
 *
 * The key and the semantics live here; the value's own validation and the settings form's wording
 * stay inside the connector, because what a channel id looks like and where an admin copies one
 * from are platform facts.
 */
import type { ChatWorkspaceSettings } from "./install"

/** Key in {@link ChatWorkspaceSettings}: the channels the bot may answer in. */
export const ALLOWED_CHANNELS_SETTING = "allowed_channel_ids"

/**
 * The listed channel ids.
 *
 * Commas, spaces and newlines all separate: the field is a text box, and an admin pasting a column
 * of ids means the same thing as one typing them inline.
 */
const listedChannelIds = (settings: ChatWorkspaceSettings): ReadonlyArray<string> =>
	(settings[ALLOWED_CHANNELS_SETTING] ?? "").split(/[\s,]+/u).filter((id) => id.length > 0)

/**
 * Whether the bot is active in a channel.
 *
 * An empty list is NOWHERE, deliberately. The alternative — an empty list meaning everywhere —
 * would have a workspace-wide install listening in every channel it can see from the moment it is
 * linked, and an admin who has not said where the bot belongs has not said yes to that.
 *
 * A thread counts as the channel it was started in, and the caller passes the resolved channel:
 * only a connector knows whether its platform models a thread as a channel of its own.
 */
export const isChannelAllowed = (settings: ChatWorkspaceSettings, channelId: string): boolean =>
	listedChannelIds(settings).includes(channelId)
