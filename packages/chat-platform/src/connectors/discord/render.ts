/**
 * Blocks → a Discord message body.
 *
 * Pure, and the only place Discord's dialect is written down: its markdown subset (no tables, no
 * raw HTML), its embeds, its action rows, and the two limits that decide what a body may contain.
 *
 * Verified against Discord's REST documentation for API v10: message `content` is at most 2000
 * characters, a message carries at most 10 embeds, an action row at most 5 buttons, and a button's
 * `custom_id` is 1–100 characters.
 */
import type { ChatBlock, ChatToolActivity } from "../../render/blocks"

/** https://discord.com/developers — Create/Edit Message JSON params, API v10. */
export interface DiscordEmbed {
	readonly title?: string
	readonly description?: string
	readonly image?: { readonly url: string }
}

export interface DiscordButton {
	readonly type: 2
	/** 3 = success, 4 = danger. */
	readonly style: 3 | 4
	readonly label: string
	readonly custom_id: string
}

export interface DiscordActionRow {
	readonly type: 1
	readonly components: ReadonlyArray<DiscordButton>
}

export interface DiscordMessagePayload {
	readonly content: string
	readonly embeds: ReadonlyArray<DiscordEmbed>
	readonly components: ReadonlyArray<DiscordActionRow>
	/**
	 * Nothing the model writes may ping anybody. An agent quoting a service called `@everyone`, or
	 * a log line holding a role mention, would otherwise notify a whole server.
	 */
	readonly allowed_mentions: { readonly parse: ReadonlyArray<string> }
}

export const MAX_CONTENT_CHARS = 2000
export const MAX_EMBEDS = 10
export const MAX_CUSTOM_ID_CHARS = 100

/** What one message's worth of blocks becomes. */
export const renderDiscordMessage = (blocks: ReadonlyArray<ChatBlock>): DiscordMessagePayload => {
	const lines: Array<string> = []
	const embeds: Array<DiscordEmbed> = []
	const rows: Array<DiscordActionRow> = []

	for (const block of blocks) {
		switch (block.kind) {
			case "prose":
				lines.push(block.markdown)
				break
			case "chart": {
				if (block.imageUrl !== null && embeds.length < MAX_EMBEDS) {
					embeds.push({
						...(block.title === null ? undefined : { title: block.title }),
						description: block.summary,
						image: { url: block.imageUrl },
					})
					break
				}
				lines.push(block.title === null ? block.summary : `**${block.title}** — ${block.summary}`)
				break
			}
			case "entity": {
				// A quote block is the closest Discord has to the card the web transcript draws, and it
				// survives sitting between two paragraphs.
				const label = block.url === null ? block.label : `[${block.label}](${block.url})`
				const detail = block.detail === null ? "" : `\n> ${block.detail}`
				lines.push(`> **${ENTITY_LABELS[block.entity]}** ${label}${detail}`)
				break
			}
			case "activity":
				if (block.tools.length > 0) lines.push(`Tools: ${block.tools.map(toolLabel).join(" · ")}`)
				break
			case "approval": {
				lines.push(
					`**Approve \`${block.toolName}\`?**${block.summary === "" ? "" : `\n${block.summary}`}`,
				)
				const row = approvalRow(block.token, block.toolName)
				if (row === null) lines.push("This one has to be approved in Maple.")
				else rows.push(row)
				break
			}
			case "notice":
				lines.push(block.tone === "error" ? `**${block.text}**` : `_${block.text}_`)
				break
		}
	}

	const content = lines.join("\n\n")
	return {
		// The neutral cut works to an estimate of what a dialect costs, and a body over the limit is
		// rejected whole — so the estimate is clamped here rather than trusted.
		content:
			content.length > MAX_CONTENT_CHARS
				? `${content.slice(0, MAX_CONTENT_CHARS - 1)}…`
				: content === "" && embeds.length === 0
					? EMPTY_CONTENT
					: content,
		embeds,
		components: rows,
		allowed_mentions: { parse: [] },
	}
}

/**
 * A message with nothing in it: Discord rejects a body carrying no content, no embed and no
 * component, and the driver empties a message that a retraction shrank a turn past.
 */
export const EMPTY_CONTENT = "—"

const ENTITY_LABELS = {
	trace: "Trace",
	service: "Service",
	error: "Error",
	log: "Log",
} as const

/**
 * Tool names carry underscores, which Discord reads as italics, so a name is always in backticks
 * rather than the surrounding line being styled.
 */
const toolLabel = (tool: ChatToolActivity): string => {
	const detail = tool.detail === null ? "" : ` (${tool.detail})`
	const status = tool.status === "running" ? "…" : tool.status === "failed" ? " (failed)" : ""
	return `\`${tool.name}\`${detail}${status}`
}

export const APPROVE_ACTION = "approve"
export const DENY_ACTION = "deny"

/**
 * The two buttons, carrying the driver's action token through Discord's `custom_id`.
 *
 * A tool call id is assigned by the model provider, so the token's length is not ours to bound: a
 * pair that would not fit is dropped rather than sent, because Discord rejects the whole message
 * over one oversized `custom_id`.
 */
const approvalRow = (token: string, toolName: string): DiscordActionRow | null => {
	const approve = `${APPROVE_ACTION}:${token}`
	const deny = `${DENY_ACTION}:${token}`
	if (approve.length > MAX_CUSTOM_ID_CHARS || deny.length > MAX_CUSTOM_ID_CHARS) return null
	return {
		type: 1,
		components: [
			{
				type: 2,
				style: 3,
				label: `Run ${toolName}`.slice(0, MAX_BUTTON_LABEL_CHARS),
				custom_id: approve,
			},
			{ type: 2, style: 4, label: "Skip", custom_id: deny },
		],
	}
}

const MAX_BUTTON_LABEL_CHARS = 80
