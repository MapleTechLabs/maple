/**
 * Blocks → a Slack message body.
 *
 * Pure, and the only place Slack's dialect is written down beside `mrkdwn.ts`: its Block Kit
 * vocabulary, its buttons, and the limits that decide what a body may contain.
 *
 * Verified against Slack's Block Kit reference: a message carries at most 50 blocks, a `section`'s
 * `text` at most 3000 characters, an `actions` block at most 25 elements, a button's `text` at most
 * 75 characters and its `value` at most 2000, a `context` block at most 10 elements, an `image`
 * block's `image_url` at most 3000 characters with a REQUIRED `alt_text` of at most 2000, and a
 * message's top-level `text` at most 40000. A `header`'s text is plain text of at most 150, a
 * `section` carries at most 10 `fields` of at most 2000 each, and a link button's `url` is at most
 * 3000.
 */
import { chatActionControlId, type ChatActionToken } from "../../action-token"
import type { ChatAlertBlock, ChatBlock, ChatToolActivity } from "../../render/blocks"
import { escapeMrkdwn, toMrkdwn } from "./mrkdwn"

export interface SlackText {
	readonly type: "mrkdwn"
	readonly text: string
}

export interface SlackPlainText {
	readonly type: "plain_text"
	readonly text: string
	readonly emoji?: boolean
}

export interface SlackHeader {
	readonly type: "header"
	readonly text: SlackPlainText
}

export interface SlackSection {
	readonly type: "section"
	readonly text: SlackText
	readonly fields?: ReadonlyArray<SlackText>
}

export interface SlackContext {
	readonly type: "context"
	readonly elements: ReadonlyArray<SlackText>
}

export interface SlackImage {
	readonly type: "image"
	readonly image_url: string
	readonly alt_text: string
	readonly title?: { readonly type: "plain_text"; readonly text: string }
}

export interface SlackButton {
	readonly type: "button"
	readonly text: SlackPlainText
	readonly action_id: string
	/** The approval token. Absent on a link button, which is what the webhook drops a click on. */
	readonly value?: string
	/** A link button opens this and carries nothing back to Maple. */
	readonly url?: string
	/** Slack's two emphatic styles; anything else is the default grey. */
	readonly style?: "primary" | "danger"
}

export interface SlackActions {
	readonly type: "actions"
	readonly elements: ReadonlyArray<SlackButton>
}

export type SlackBlock = SlackHeader | SlackSection | SlackContext | SlackImage | SlackActions

/**
 * A legacy attachment, kept for the one thing Block Kit has no equivalent of: the coloured bar
 * down the side of a message. An alert's blocks ride inside one.
 */
export interface SlackAttachment {
	readonly color: string
	/** What a notification preview shows, since the message carries no top-level `text`. */
	readonly fallback: string
	readonly blocks: ReadonlyArray<SlackBlock>
}

export interface SlackMessagePayload {
	/**
	 * The notification and accessibility fallback. Slack recommends it on every message that
	 * carries blocks — it is what a push notification and a screen reader read — and it is the one
	 * field a client with no Block Kit support shows.
	 *
	 * Absent on a message that is only attachments: beside one, Slack renders `text` as a duplicate
	 * line above the bar, and the attachment's `fallback` does its job instead.
	 */
	readonly text?: string
	readonly blocks?: ReadonlyArray<SlackBlock>
	readonly attachments?: ReadonlyArray<SlackAttachment>
	/** Model-authored text should not turn a link into a preview card in somebody's channel. */
	readonly unfurl_links: false
	readonly unfurl_media: false
}

/**
 * One `chat.postMessage` or `chat.update` body: a rendered message plus where it goes.
 *
 * `thread_ts` names the thread on a post and is absent on an update, which addresses the message by
 * its own `ts` — so both are optional and the transport supplies whichever the call takes.
 */
export interface SlackMessageRequest extends SlackMessagePayload {
	readonly channel: string
	readonly thread_ts?: string
	readonly ts?: string
	/** `chat.postEphemeral`'s one extra argument: who alone sees it. */
	readonly user?: string
}

/**
 * One read of a conversation: `conversations.history` for a channel, `conversations.replies` for a
 * thread, which is the same arguments plus the parent message's `ts`.
 */
export interface SlackHistoryRequest {
	readonly channel: string
	readonly limit: number
	/** The end of the range. With `inclusive: false` this is "everything before this message". */
	readonly latest: string
	readonly inclusive: false
	/** The thread's parent, for `conversations.replies` only. */
	readonly ts?: string
}

/** Everything the transport sends. Both are JSON bodies to a Web API method. */
export type SlackApiRequest = SlackMessageRequest | SlackHistoryRequest

export const MAX_BLOCKS = 50
export const MAX_SECTION_CHARS = 3000
export const MAX_BUTTON_TEXT_CHARS = 75
export const MAX_BUTTON_VALUE_CHARS = 2000
export const MAX_IMAGE_URL_CHARS = 3000
export const MAX_ALT_TEXT_CHARS = 2000
export const MAX_FALLBACK_CHARS = 40000
export const MAX_HEADER_CHARS = 150
export const MAX_FIELDS = 10
export const MAX_FIELD_CHARS = 2000
export const MAX_LINK_BUTTONS = 5

export const APPROVE_ACTION = "maple_approve"
export const DENY_ACTION = "maple_deny"

/** A message with nothing in it: Slack rejects a post carrying neither text nor blocks. */
export const EMPTY_TEXT = "—"

const clamp = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`

const section = (text: string): SlackSection => ({
	type: "section",
	text: { type: "mrkdwn", text: clamp(text, MAX_SECTION_CHARS) },
})

const context = (text: string): SlackContext => ({
	type: "context",
	elements: [{ type: "mrkdwn", text: clamp(text, MAX_SECTION_CHARS) }],
})

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
	const detail = tool.detail === null ? "" : ` (${escapeMrkdwn(tool.detail)})`
	const status = tool.status === "failed" ? "… (failed)" : "…"
	return `${escapeMrkdwn(tool.label)}${detail}${status}`
}

/**
 * The two buttons, carrying the driver's action control id in a button's `value`.
 *
 * The value is Maple's, not Slack's — the host reads the decision back off it, so the format is
 * `chatActionControlId`'s, and `action_id` only keeps the two buttons distinct within the block.
 * A tool call id is assigned by the model provider, so the length is not ours to bound — but
 * Slack's 2000 characters is wide enough that a value which does not fit is a token that is wrong.
 * A pair that would not fit is dropped rather than sent, because Slack rejects the whole message
 * over one oversized value.
 */
const approvalActions = (token: ChatActionToken, toolName: string): SlackActions | null => {
	const approve = chatActionControlId("approve", token)
	const deny = chatActionControlId("deny", token)
	if (approve.length > MAX_BUTTON_VALUE_CHARS || deny.length > MAX_BUTTON_VALUE_CHARS) return null
	return {
		type: "actions",
		elements: [
			{
				type: "button",
				text: { type: "plain_text", text: clamp(`Run ${toolName}`, MAX_BUTTON_TEXT_CHARS) },
				action_id: APPROVE_ACTION,
				value: approve,
				style: "primary",
			},
			{
				type: "button",
				text: { type: "plain_text", text: "Skip" },
				action_id: DENY_ACTION,
				value: deny,
				style: "danger",
			},
		],
	}
}

/**
 * A chart, as a picture where there is one and as its summary where there is not.
 *
 * `alt_text` is required by Slack, and the summary is exactly what it is for: the sentence that
 * stands in for the plot. The URL is bounded because an over-long one is not a broken image, it is
 * a rejected message — and with it the whole turn.
 */
const chartBlocks = (block: Extract<ChatBlock, { kind: "chart" }>): ReadonlyArray<SlackBlock> => {
	// Both branches escape. A chart's title and summary are built from model-authored chart JSON,
	// so an unescaped one is the same hole as an unescaped paragraph: `<!channel>` in a summary
	// would page the workspace.
	const heading =
		block.title === null
			? escapeMrkdwn(block.summary)
			: `*${escapeMrkdwn(block.title)}* — ${escapeMrkdwn(block.summary)}`
	if (block.imageUrl === null || block.imageUrl.length > MAX_IMAGE_URL_CHARS) {
		return [section(heading)]
	}
	return [
		section(heading),
		{
			type: "image",
			image_url: block.imageUrl,
			alt_text: clamp(block.summary === "" ? "Chart" : block.summary, MAX_ALT_TEXT_CHARS),
		},
	]
}

/** `<!date^…>` renders the time in each reader's own timezone; the ISO string is its fallback. */
const slackDate = (ms: number): string =>
	`<!date^${Math.floor(ms / 1000)}^{date_short_pretty} at {time}|${new Date(ms).toISOString()}>`

/**
 * An alert as the card it has always been in Slack: a header, the summary with its facts as
 * fields, the chart, the links as buttons and a small footer — all inside an attachment for the
 * coloured bar.
 */
const alertAttachment = (block: ChatAlertBlock): SlackAttachment => {
	const summary = toMrkdwn(block.summary)
	const blocks: Array<SlackBlock> = [
		{
			type: "header",
			text: { type: "plain_text", text: clamp(block.title, MAX_HEADER_CHARS), emoji: true },
		},
		{
			...section(summary.trim() === "" ? EMPTY_TEXT : summary),
			...(block.fields.length === 0
				? undefined
				: {
						fields: block.fields.slice(0, MAX_FIELDS).map((field) => ({
							type: "mrkdwn" as const,
							text: clamp(
								`*${escapeMrkdwn(field.label)}*\n${toMrkdwn(field.value)}`,
								MAX_FIELD_CHARS,
							),
						})),
					}),
		},
	]
	if (block.imageUrl !== null && block.imageUrl.length <= MAX_IMAGE_URL_CHARS) {
		blocks.push({
			type: "image",
			image_url: block.imageUrl,
			alt_text: clamp(block.imageAlt === "" ? "Chart" : block.imageAlt, MAX_ALT_TEXT_CHARS),
		})
	}
	// A link too long for a button is left out rather than sent: Slack rejects the whole message.
	const links = block.links
		.filter((link) => link.url.length <= MAX_IMAGE_URL_CHARS)
		.slice(0, MAX_LINK_BUTTONS)
	if (links.length > 0) {
		blocks.push({
			type: "actions",
			elements: links.map((link, index) => ({
				type: "button",
				text: { type: "plain_text", text: clamp(link.label, MAX_BUTTON_TEXT_CHARS), emoji: true },
				action_id: `maple_link_${index}`,
				url: link.url,
				...(link.primary ? { style: "primary" as const } : undefined),
			})),
		})
	}
	const footer = [
		...block.footer.map(toMrkdwn),
		...(block.sentAtMs === null ? [] : [slackDate(block.sentAtMs)]),
	]
	if (footer.length > 0) blocks.push(context(footer.join("  ·  ")))
	return {
		color: block.color,
		fallback: clamp(
			escapeMrkdwn(`${block.title} · ${block.summary.replaceAll("**", "")}`),
			MAX_FALLBACK_CHARS,
		),
		blocks,
	}
}

/** What one message's worth of blocks becomes. */
export const renderSlackMessage = (blocks: ReadonlyArray<ChatBlock>): SlackMessagePayload => {
	const rendered: Array<SlackBlock> = []
	const attachments: Array<SlackAttachment> = []
	/** The fallback text, built from the same content the blocks are. */
	const fallback: Array<string> = []

	for (const block of blocks) {
		switch (block.kind) {
			case "prose": {
				const text = toMrkdwn(block.markdown)
				if (text.trim() !== "") rendered.push(section(text))
				fallback.push(block.markdown)
				break
			}
			case "chart":
				rendered.push(...chartBlocks(block))
				fallback.push(block.title === null ? block.summary : `${block.title} — ${block.summary}`)
				break
			case "entity": {
				const label = escapeMrkdwn(block.label)
				const link = block.url === null ? label : `<${block.url}|${label}>`
				const detail = block.detail === null ? "" : `\n${escapeMrkdwn(block.detail)}`
				rendered.push(section(`*${ENTITY_LABELS[block.entity]}* ${link}${detail}`))
				fallback.push(`${ENTITY_LABELS[block.entity]} ${block.label}`)
				break
			}
			case "activity":
				if (block.tools.length > 0) {
					rendered.push(context(block.tools.map(toolLabel).join(" · ")))
					fallback.push(block.tools.map((tool) => tool.label).join(", "))
				}
				break
			case "approval": {
				const { outcome } = block
				if (outcome !== null) {
					// A decided proposal loses its buttons: Slack leaves a button clickable forever, and
					// the click would only ever be answered "settled". What it asked for gives way to
					// what came of it, with who decided underneath.
					const link = outcome.url === null ? "" : ` <${outcome.url}|Open in Maple>`
					if (outcome.text === "") {
						rendered.push(
							section(
								`*\`${escapeMrkdwn(block.toolName)}\`* ${escapeMrkdwn(outcome.decision)}${link}`,
							),
						)
					} else {
						rendered.push(section(`${escapeMrkdwn(outcome.text)}${link}`))
						rendered.push(context(escapeMrkdwn(outcome.decision)))
					}
					// The top-level text is what a screen reader reads, so it carries the decision and link too.
					fallback.push(
						outcome.text === ""
							? `${block.toolName}: ${outcome.decision}${link}`
							: `${outcome.text}${link}\n${outcome.decision}`,
					)
					break
				}
				const summary = block.summary === "" ? "" : `\n${escapeMrkdwn(block.summary)}`
				rendered.push(section(`*Approve \`${escapeMrkdwn(block.toolName)}\`?*${summary}`))
				const actions = approvalActions(block.token, block.toolName)
				if (actions === null) rendered.push(section("This one has to be approved in Maple."))
				else rendered.push(actions)
				fallback.push(`Approve ${block.toolName}?`)
				break
			}
			case "notice":
				rendered.push(
					block.tone === "error"
						? section(`*${escapeMrkdwn(block.text)}*`)
						: context(escapeMrkdwn(block.text)),
				)
				fallback.push(block.text)
				break
			case "alert":
				attachments.push(alertAttachment(block))
				break
			default:
				// A block kind added to the neutral model but not to this dialect would otherwise
				// render as nothing at all.
				block satisfies never
		}
	}

	if (rendered.length === 0 && attachments.length > 0) {
		return { attachments, unfurl_links: false, unfurl_media: false }
	}
	const text = fallback.join("\n\n").trim()
	return {
		...(attachments.length === 0 ? undefined : { attachments }),
		text: clamp(text === "" ? EMPTY_TEXT : text, MAX_FALLBACK_CHARS),
		// The cut is at the block level and keeps the FIRST blocks: a turn's answer opens with what
		// it found, and the tail of a long one is its working.
		blocks: rendered.length === 0 ? [section(EMPTY_TEXT)] : rendered.slice(0, MAX_BLOCKS),
		unfurl_links: false,
		unfurl_media: false,
	}
}
