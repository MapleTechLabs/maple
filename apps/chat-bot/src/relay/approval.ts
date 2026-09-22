/**
 * Who may approve a write Maple proposed, and what the conversation shows once somebody has.
 *
 * Pure, and vendor-neutral by construction: every input is either a stored setting or a membership
 * fact the connector reported as data. No platform can answer the question itself — a bot that
 * trusted "the platform let them click it" would let anybody in a channel run a change against the
 * org's data.
 */
import {
	APPROVER_ROLE_SETTING,
	decodeChatActionToken,
	renderChatMessage,
	splitBlocks,
	type ChatBlock,
	type ChatRenderContext,
	type ChatWorkspaceSettings,
	type InboundActor,
} from "@maple/chat-platform"
import type { ChatMessage } from "@maple/domain/chat-session"
import { Option } from "effect"

/**
 * Whether this person may decide this workspace's proposals.
 *
 * Two rules, and the second is the fallback for a workspace that has not configured the first:
 * a configured approver role is the whole answer, and where none is configured it is whoever the
 * platform says may manage the workspace. Never both — a configured role that somebody does not
 * hold is a refusal even for an administrator, because configuring the role is how an org says
 * who it meant.
 */
export const mayApprove = (settings: ChatWorkspaceSettings, actor: InboundActor): boolean => {
	const role = settings[APPROVER_ROLE_SETTING]?.trim()
	return role === undefined || role === "" ? actor.isWorkspaceAdmin : actor.roleIds.includes(role)
}

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

/** Short, neutral, and the same for every reason somebody may not decide: it is not a hint sheet. */
export const NOT_AN_APPROVER_NOTICE =
	"You're not set up to approve Maple's changes in this workspace — ask someone who is."

/** The control outlived what it pointed at: a wiped conversation, or a build that changed the log. */
export const PROPOSAL_GONE_NOTICE = "That change isn't waiting for a decision any more."
