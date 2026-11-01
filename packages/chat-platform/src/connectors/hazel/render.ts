/**
 * Blocks → a Hazel message body: markdown `content` plus `embeds`.
 *
 * Pure, and the only place Hazel's dialect is written down: its embed shape (`@hazel/domain`'s
 * `MessageEmbed`), the buttons an embed carries (`actions`, at most five, each id 1–100
 * characters), and its mention markup, which nothing the model writes may produce.
 */
import { chatActionControlId, type ChatActionToken } from "../../action-token"
import type { ChatAlertBlock, ChatBlock, ChatToolActivity } from "../../render/blocks"

/** A button on an embed. Pressing it sends the bot an `interaction.create` carrying `id`. */
export interface HazelEmbedAction {
	readonly id: string
	readonly label: string
	readonly style?: "primary" | "secondary" | "danger"
}

/** `MessageEmbed`, as far as this connector writes one. */
export interface HazelEmbed {
	readonly title?: string
	readonly description?: string
	readonly url?: string
	/** The bar down the side, as a 24-bit integer. */
	readonly color?: number
	readonly fields?: ReadonlyArray<{
		readonly name: string
		readonly value: string
		readonly inline: boolean
	}>
	readonly image?: { readonly url: string }
	readonly footer?: { readonly text: string }
	/** ISO 8601. */
	readonly timestamp?: string
	readonly actions?: ReadonlyArray<HazelEmbedAction>
	/** Turns live rendering on: Hazel shows the message's live state in place of its content. */
	readonly liveState?: HazelLiveState
}

/** `MessageEmbedLiveState`, as far as this connector writes one. */
export interface HazelLiveState {
	readonly enabled: true
	readonly loading?: HazelLiveLoading
	/**
	 * The finished state, for a client without the live socket. Written with the message's final
	 * content, so the two never disagree.
	 */
	readonly cached?: {
		readonly status: "completed" | "failed"
		readonly data: Readonly<Record<string, never>>
		readonly text?: string
		readonly error?: string
	}
}

export interface HazelMessageBody {
	readonly content: string
	readonly embeds: ReadonlyArray<HazelEmbed>
}

/**
 * Hazel sets no limit on `content`; this is the one the neutral cutting is held under (with room
 * for decoration), so a turn still splits into messages a reader can take in.
 */
export const MAX_CONTENT_CHARS = 4000
const MAX_EMBED_TITLE_CHARS = 256
const MAX_EMBED_DESCRIPTION_CHARS = 4096
const MAX_EMBED_FIELDS = 25
const MAX_FIELD_NAME_CHARS = 256
const MAX_FIELD_VALUE_CHARS = 1024
const MAX_FOOTER_CHARS = 2048
export const MAX_ACTION_ID_CHARS = 100
const MAX_ACTION_LABEL_CHARS = 80

/**
 * A message with nothing in it: the driver posts an empty placeholder before the first words, and
 * empties a message a retraction shrank a turn past.
 */
export const EMPTY_CONTENT = "—"

/**
 * Hazel's mention markup, defused. `@[userId:…]` pings a person and `@[directive:channel]` a whole
 * channel; a model quoting either, or a log line holding one, must not notify anybody. A zero-width
 * space after the `@` leaves the text readable and the markup inert.
 */
export const defuseMentions = (text: string): string => text.replaceAll("@[", "@​[")

/** What one message's worth of blocks becomes. */
export const renderHazelMessage = (blocks: ReadonlyArray<ChatBlock>): HazelMessageBody => {
	const { content, embeds } = renderParts(blocks)
	return { content: content === "" && embeds.length === 0 ? EMPTY_CONTENT : content, embeds }
}

/**
 * `MessageEmbedLiveState`'s loading indicator: what a live message shows before it has any text.
 * Hazel animates the dots itself.
 */
export interface HazelLiveLoading {
	readonly text: string
}

/**
 * A message streamed through Hazel's live state: the message body, for search, notifications and
 * history, and what the live state shows while the turn runs.
 */
export interface HazelLiveBody extends HazelMessageBody {
	/**
	 * The live state's text: the content without a pending notice, which Hazel's own loading
	 * indicator stands in for, and without the failure a turn closes on, which is `error`.
	 */
	readonly text: string
	/** The failure the turn closed on, shown by Hazel as the live state's error card. */
	readonly error: string | null
	/** What a pending notice said, for the loading indicator. */
	readonly loading: HazelLiveLoading | null
}

export const renderHazelLive = (blocks: ReadonlyArray<ChatBlock>): HazelLiveBody => {
	const last = blocks.at(-1)
	const failure = last?.kind === "notice" && last.tone === "error" ? last : null
	const pending = blocks.find((block) => block.kind === "notice" && block.tone === "pending")
	const shown = blocks.filter(
		(block) => block !== failure && !(block.kind === "notice" && block.tone === "pending"),
	)
	return {
		...renderHazelMessage(blocks),
		text: renderParts(shown).content,
		error: failure === null ? null : defuseMentions(failure.text),
		loading:
			pending?.kind === "notice" ? { text: defuseMentions(pending.text.replace(/…$/u, "")) } : null,
	}
}

/** The content, possibly empty, and the embeds. */
const renderParts = (blocks: ReadonlyArray<ChatBlock>): HazelMessageBody => {
	const lines: Array<string> = []
	const embeds: Array<HazelEmbed> = []

	for (const block of blocks) {
		switch (block.kind) {
			case "prose":
				lines.push(block.markdown)
				break
			case "chart": {
				if (block.imageUrl !== null) {
					embeds.push({
						...(block.title === null
							? undefined
							: { title: clamp(block.title, MAX_EMBED_TITLE_CHARS) }),
						description: clamp(block.summary, MAX_EMBED_DESCRIPTION_CHARS),
						image: { url: block.imageUrl },
					})
					break
				}
				lines.push(block.title === null ? block.summary : `**${block.title}** — ${block.summary}`)
				break
			}
			case "entity": {
				const label = block.url === null ? block.label : `[${block.label}](${block.url})`
				const detail = block.detail === null ? "" : `\n> ${block.detail}`
				lines.push(`> **${ENTITY_LABELS[block.entity]}** ${label}${detail}`)
				break
			}
			case "activity":
				if (block.tools.length > 0) lines.push(`_${block.tools.map(toolLabel).join(" · ")}_`)
				break
			case "approval": {
				const { outcome } = block
				if (outcome !== null) {
					// A decided proposal loses its buttons, and what it asked for gives way to what came
					// of it, with who decided underneath.
					const link = outcome.url === null ? "" : ` [Open in Maple](${outcome.url})`
					lines.push(
						outcome.text === ""
							? `**\`${block.toolName}\`** ${outcome.decision}${link}`
							: `${outcome.text}${link}\n_${outcome.decision}_`,
					)
					break
				}
				const actions = approvalActions(block.token, block.toolName)
				embeds.push({
					title: clamp(`Approve ${block.toolName}?`, MAX_EMBED_TITLE_CHARS),
					...(block.summary === ""
						? undefined
						: { description: clamp(block.summary, MAX_EMBED_DESCRIPTION_CHARS) }),
					...(actions === null
						? { footer: { text: "This one has to be approved in Maple." } }
						: { actions }),
				})
				break
			}
			case "notice":
				lines.push(block.tone === "error" ? `**${block.text}**` : `_${block.text}_`)
				break
			case "alert":
				embeds.push(alertEmbed(block))
				break
			default:
				// A block kind added to the neutral model but not to this dialect would otherwise
				// render as nothing at all.
				block satisfies never
		}
	}

	return {
		content: clamp(defuseMentions(lines.join("\n\n")), MAX_CONTENT_CHARS),
		embeds: embeds.map(defuseEmbed),
	}
}

const defuseEmbed = (embed: HazelEmbed): HazelEmbed => ({
	...embed,
	...(embed.title === undefined ? undefined : { title: defuseMentions(embed.title) }),
	...(embed.description === undefined ? undefined : { description: defuseMentions(embed.description) }),
	...(embed.fields === undefined
		? undefined
		: {
				fields: embed.fields.map((field) => ({
					...field,
					name: defuseMentions(field.name),
					value: defuseMentions(field.value),
				})),
			}),
	...(embed.footer === undefined ? undefined : { footer: { text: defuseMentions(embed.footer.text) } }),
})

/** An alert as a card: the title linking into Maple, the summary, the facts, the chart, a footer. */
const alertEmbed = (block: ChatAlertBlock): HazelEmbed => {
	const primary = block.links.find((link) => link.primary) ?? block.links[0]
	const links = block.links.map((link) => `[${link.label}](${link.url})`).join(" · ")
	const fields = [
		...block.fields.map((field) => ({ name: field.label, value: field.value, inline: true })),
		...(links === "" ? [] : [{ name: "Links", value: links, inline: false }]),
	]
		.filter((field) => field.name !== "" && field.value !== "")
		.slice(0, MAX_EMBED_FIELDS)
		.map((field) => ({
			name: clamp(field.name, MAX_FIELD_NAME_CHARS),
			value: clamp(field.value, MAX_FIELD_VALUE_CHARS),
			inline: field.inline,
		}))
	const footer = block.footer.map((part) => part.replaceAll("`", "")).join("  ·  ")
	return {
		title: clamp(block.title, MAX_EMBED_TITLE_CHARS),
		...(primary === undefined ? undefined : { url: primary.url }),
		color: Number.parseInt(block.color.slice(1), 16),
		...(block.summary === ""
			? undefined
			: { description: clamp(block.summary, MAX_EMBED_DESCRIPTION_CHARS) }),
		...(fields.length === 0 ? undefined : { fields }),
		...(block.imageUrl === null ? undefined : { image: { url: block.imageUrl } }),
		...(footer === "" ? undefined : { footer: { text: clamp(footer, MAX_FOOTER_CHARS) } }),
		...(block.sentAtMs === null ? undefined : { timestamp: new Date(block.sentAtMs).toISOString() }),
	}
}

const clamp = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`

const ENTITY_LABELS = {
	trace: "Trace",
	service: "Service",
	error: "Error",
	log: "Log",
} as const

const toolLabel = (tool: ChatToolActivity): string => {
	const detail = tool.detail === null ? "" : ` (${tool.detail})`
	const status = tool.status === "failed" ? "… (failed)" : "…"
	return `${tool.label}${detail}${status}`
}

/**
 * The two buttons, carrying the driver's action control id as the action's `id`. A tool call id is
 * the model provider's, so its length is not ours to bound: a pair that would not fit Hazel's 100
 * characters is left off, because Hazel rejects the whole message over one oversized id.
 */
const approvalActions = (
	token: ChatActionToken,
	toolName: string,
): ReadonlyArray<HazelEmbedAction> | null => {
	const approve = chatActionControlId("approve", token)
	const deny = chatActionControlId("deny", token)
	if (approve.length > MAX_ACTION_ID_CHARS || deny.length > MAX_ACTION_ID_CHARS) return null
	return [
		{ id: approve, label: clamp(`Run ${toolName}`, MAX_ACTION_LABEL_CHARS), style: "primary" },
		{ id: deny, label: "Skip", style: "secondary" },
	]
}
