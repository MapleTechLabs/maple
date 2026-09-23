/**
 * What a settled proposal's message should now say.
 *
 * Its own file because it is the one piece of the approval path that is pure rendering: the turn
 * is re-rendered from the transcript rather than patched, so the proposal's block is still there,
 * carrying its outcome instead of its buttons.
 */
import {
	decodeChatActionToken,
	renderChatMessage,
	splitBlocks,
	type ChatBlock,
	type ChatRenderContext,
} from "@maple/chat-platform"
import type { ChatMessage } from "@maple/domain/chat-session"
import { Option } from "effect"

/**
 * The cutting charges an approval for its outcome whether or not it has one
 * (`MAX_APPROVAL_OUTCOME_CHARS`), so the group holding the proposal is the same group that was
 * posted as the clicked message — which is what makes editing that message in place correct.
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
	// The caller found this message BY the call, so its approval block is in one of these groups.
	return groups.find(holdsProposal) ?? []
}
