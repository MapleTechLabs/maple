/**
 * Who may approve a write Maple proposed, and what the conversation shows once somebody has.
 *
 * Pure, and vendor-neutral by construction: the inputs are whether the connector can prove who
 * clicked, and whether that person has linked their chat account to a Maple user. No platform
 * answers the question itself — a bot that trusted "the platform let them click it" would let
 * anybody in a channel run a change against the org's data.
 */
import {
	decodeChatActionToken,
	renderChatMessage,
	splitBlocks,
	type ChatBlock,
	type ChatRenderContext,
} from "@maple/chat-platform"
import type { ChatMessage } from "@maple/domain/chat-session"
import type { UserId } from "@maple/domain/primitives"
import { Option } from "effect"

/**
 * What a click is allowed to do, and whose authority it runs under.
 *
 * Three cases, because a chat platform gives Maple one of three things:
 *
 *   - `org` — the connector cannot prove who clicked, so there is nobody to be. Anyone who can see
 *     the conversation may approve, and the change runs as the org-level connector identity. This
 *     is the weaker rule and it is deliberate: without an identity half the alternative is a bot
 *     that can propose changes and never apply them.
 *   - `user` — the clicker linked this chat account to a Maple user, so the change runs as that
 *     user, under whatever roles they hold in the org right now. A tool that requires an admin
 *     enforces that itself; nothing here grants anything.
 *   - `unlinked` — the connector CAN prove who clicked and this person has not linked. Refused,
 *     because the alternative is silently falling back to the weaker rule on the one platform
 *     where the stronger one was available.
 */
export type ApprovalPolicy =
	| { readonly _tag: "org" }
	| { readonly _tag: "user"; readonly userId: UserId }
	| { readonly _tag: "unlinked" }

export const approvalPolicy = (
	supportsIdentity: boolean,
	linkedUserId: UserId | undefined,
): ApprovalPolicy => {
	if (!supportsIdentity) return { _tag: "org" }
	return linkedUserId === undefined ? { _tag: "unlinked" } : { _tag: "user", userId: linkedUserId }
}

/** Where somebody goes to link their account — Maple's own page, which is where a session is. */
export const linkNotice = (appBaseUrl: string): string =>
	`Link your chat account to Maple before approving changes: ${appBaseUrl}/integrations`

/**
 * What the message that carried the controls should now say.
 *
 * The turn is re-rendered from the transcript rather than patched: the proposal's block is still
 * there, now carrying its outcome instead of its buttons, and everything else in the message is
 * what it always was. The cutting charges an approval for its outcome whether or not it has one
 * (`MAX_APPROVAL_OUTCOME_CHARS`), so the group holding the proposal is the same group that was
 * posted as the clicked message.
 */
export const settledMessageBlocks = (
	message: ChatMessage,
	toolCallId: string,
	context: ChatRenderContext,
	maxMessageChars: number,
): ReadonlyArray<ChatBlock> => {
	const groups = splitBlocks(renderChatMessage(message, context), maxMessageChars)
	const holdsProposal = (group: ReadonlyArray<ChatBlock>) =>
		group.some(
			(block) =>
				block.kind === "approval" &&
				Option.exists(
					decodeChatActionToken(block.token),
					(action) => action.toolCallId === toolCallId,
				),
		)
	return groups.find(holdsProposal) ?? groups[groups.length - 1] ?? []
}

/** The assistant message that issued a proposal, or nothing if the transcript does not hold it. */
export const messageWithToolCall = (
	history: ReadonlyArray<ChatMessage>,
	toolCallId: string,
): ChatMessage | undefined =>
	history.find((message) => message.toolCalls.some((call) => call.id === toolCallId))

/** The control outlived what it pointed at: a wiped conversation, or a build that changed the log. */
export const PROPOSAL_GONE_NOTICE = "That change isn't waiting for a decision any more."
