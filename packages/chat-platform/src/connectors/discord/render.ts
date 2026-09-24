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
import { chatActionControlId, type ChatActionToken } from "../../action-token"
import type { ChatAlertBlock, ChatBlock, ChatToolActivity } from "../../render/blocks"

/** https://discord.com/developers — Create/Edit Message JSON params, API v10. */
export interface DiscordEmbed {
	readonly title?: string
	readonly url?: string
	readonly description?: string
	/** The bar down the side, as a 24-bit integer. */
	readonly color?: number
	readonly fields?: ReadonlyArray<{
		readonly name: string
		readonly value: string
		readonly inline: boolean
	}>
	readonly image?: { readonly url: string }
	readonly footer?: { readonly text: string }
	/** ISO 8601; Discord shows it in each reader's own timezone. */
	readonly timestamp?: string
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
export const MAX_ACTION_ROWS = 5
const MAX_EMBED_TITLE_CHARS = 256
const MAX_EMBED_DESCRIPTION_CHARS = 4096
const MAX_EMBED_FIELDS = 25
const MAX_FIELD_NAME_CHARS = 256
const MAX_FIELD_VALUE_CHARS = 1024
const MAX_FOOTER_CHARS = 2048
/** Discord's limit across EVERY embed on a message, which the per-field clamps cannot enforce. */
const MAX_EMBED_TOTAL_CHARS = 6000
export const MAX_CUSTOM_ID_CHARS = 100
const MAX_BUTTON_LABEL_CHARS = 80

/** What one message's worth of blocks becomes. */
export const renderDiscordMessage = (blocks: ReadonlyArray<ChatBlock>): DiscordMessagePayload => {
	const lines: Array<string> = []
	const embeds: Array<DiscordEmbed> = []
	const rows: Array<DiscordActionRow> = []
	let embedChars = 0

	for (const block of blocks) {
		switch (block.kind) {
			case "prose":
				lines.push(block.markdown)
				break
			case "chart": {
				// A title and a summary are built from model-authored chart JSON, which is bounded by
				// nothing; an over-long field is not a bad embed, it is a rejected message — and so is
				// a set of embeds that is individually fine but too long together.
				const title = block.title === null ? null : clamp(block.title, MAX_EMBED_TITLE_CHARS)
				const description = clamp(block.summary, MAX_EMBED_DESCRIPTION_CHARS)
				const cost = (title?.length ?? 0) + description.length
				if (
					block.imageUrl !== null &&
					embeds.length < MAX_EMBEDS &&
					embedChars + cost <= MAX_EMBED_TOTAL_CHARS
				) {
					embeds.push({
						...(title === null ? undefined : { title }),
						description,
						image: { url: block.imageUrl },
					})
					embedChars += cost
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
				if (block.tools.length > 0) lines.push(block.tools.map(toolLabel).join(" · "))
				break
			case "approval": {
				const { outcome } = block
				if (outcome !== null) {
					// A decided proposal loses its buttons: Discord leaves a component clickable
					// forever, and the click would only be answered "settled". What it asked for gives
					// way to what came of it, with who decided underneath.
					const link = outcome.url === null ? "" : ` [Open in Maple](${outcome.url})`
					lines.push(
						outcome.text === ""
							? `**\`${block.toolName}\`** ${outcome.decision}${link}`
							: `${outcome.text}${link}\n-# ${outcome.decision}`,
					)
					break
				}
				const detail = block.summary === "" ? "" : `\n${block.summary}`
				lines.push(`**Approve \`${block.toolName}\`?**${detail}`)
				// Each approval is one action row, and a message carries at most five of them — a sixth
				// would be rejected along with the whole turn.
				const row = rows.length < MAX_ACTION_ROWS ? approvalRow(block.token, block.toolName) : null
				if (row === null) lines.push("This one has to be approved in Maple.")
				else rows.push(row)
				break
			}
			case "notice":
				lines.push(block.tone === "error" ? `**${block.text}**` : `_${block.text}_`)
				break
			case "alert": {
				const embed = alertEmbed(block)
				const cost = embedCost(embed)
				if (embeds.length < MAX_EMBEDS && embedChars + cost <= MAX_EMBED_TOTAL_CHARS) {
					embeds.push(embed)
					embedChars += cost
					break
				}
				lines.push(`**${block.title}**\n${block.summary}`)
				break
			}
			default:
				// A block kind added to the neutral model but not to this dialect would otherwise
				// render as nothing at all.
				block satisfies never
		}
	}

	const content = lines.join("\n\n")
	return {
		// The neutral cut works to an estimate of what a dialect costs, and a body over the limit is
		// rejected whole — so the estimate is clamped here rather than trusted.
		content: content === "" && embeds.length === 0 ? EMPTY_CONTENT : clamp(content, MAX_CONTENT_CHARS),
		embeds,
		components: rows,
		allowed_mentions: { parse: [] },
	}
}

/** What an embed spends of {@link MAX_EMBED_TOTAL_CHARS}: every text field Discord counts. */
const embedCost = (embed: DiscordEmbed): number =>
	(embed.title?.length ?? 0) +
	(embed.description?.length ?? 0) +
	(embed.footer?.text.length ?? 0) +
	(embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0)

/**
 * An alert as the embed it has always been on Discord: the title linking into Maple, the summary,
 * the facts as inline fields, the links, the chart and a footer — with the state as the bar colour.
 */
const alertEmbed = (block: ChatAlertBlock): DiscordEmbed => {
	const primary = block.links.find((link) => link.primary) ?? block.links[0]
	const links = block.links.map((link) => `[${link.label}](${link.url})`).join(" · ")
	const fields = [
		...block.fields.map((field) => ({ name: field.label, value: field.value, inline: true })),
		...(links === "" ? [] : [{ name: "Links", value: links, inline: false }]),
	]
		.slice(0, MAX_EMBED_FIELDS)
		.map((field) => ({
			name: clamp(field.name, MAX_FIELD_NAME_CHARS),
			value: clamp(field.value, MAX_FIELD_VALUE_CHARS),
			inline: field.inline,
		}))
	// A footer is plain text on Discord, so inline code would show its backticks.
	const footer = block.footer.map((part) => part.replaceAll("`", "")).join("  ·  ")
	return {
		title: clamp(block.title, MAX_EMBED_TITLE_CHARS),
		...(primary === undefined ? undefined : { url: primary.url }),
		color: Number.parseInt(block.color.slice(1), 16),
		...(block.summary === ""
			? undefined
			: { description: clamp(block.summary, MAX_EMBED_DESCRIPTION_CHARS) }),
		fields,
		...(block.imageUrl === null ? undefined : { image: { url: block.imageUrl } }),
		...(footer === "" ? undefined : { footer: { text: clamp(footer, MAX_FOOTER_CHARS) } }),
		...(block.sentAtMs === null ? undefined : { timestamp: new Date(block.sentAtMs).toISOString() }),
	}
}

/**
 * A message with nothing in it: Discord rejects a body carrying no content, no embed and no
 * component, and the driver empties a message that a retraction shrank a turn past.
 */
export const EMPTY_CONTENT = "—"

const clamp = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`

const ENTITY_LABELS = {
	trace: "Trace",
	service: "Service",
	error: "Error",
	log: "Log",
} as const

/**
 * The status line: the phrase, then whether the call failed. The ellipsis stays once the call
 * finishes: dropping it on completion only made the line jump, "Running a query…" to
 * "Running a query".
 */
const toolLabel = (tool: ChatToolActivity): string => {
	const detail = tool.detail === null ? "" : ` (${tool.detail})`
	const status = tool.status === "failed" ? "… (failed)" : "…"
	return `${tool.label}${detail}${status}`
}

/**
 * The two buttons, carrying the driver's action control id through Discord's `custom_id`.
 *
 * The id itself is Maple's, not Discord's — the host reads the decision back off it, so the format
 * is `chatActionControlId`'s and this connector only holds it to its own length limit. A tool call
 * id is assigned by the model provider, so that length is not ours to bound: a pair that would not
 * fit is dropped rather than sent, because Discord rejects the whole message over one oversized
 * `custom_id`.
 */
const approvalRow = (token: ChatActionToken, toolName: string): DiscordActionRow | null => {
	const approve = chatActionControlId("approve", token)
	const deny = chatActionControlId("deny", token)
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
