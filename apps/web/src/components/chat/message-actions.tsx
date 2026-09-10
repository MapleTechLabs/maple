import { CopyButton } from "@maple/ui/components/ui/copy-button"
import type { UIMessage } from "@/components/ai-elements/types"
import { LinkIcon } from "@/components/icons"

/** The visible text of a message, with tool calls and markers left out. */
export function messageText(message: UIMessage): string {
	return message.parts
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n\n")
		.trim()
}

interface MessageActionsProps {
	message: UIMessage
	/** Absolute permalink to this message, or `undefined` where the thread isn't shareable. */
	permalink?: string
}

/**
 * Wall-clock label for a message, e.g. "Sep 11, 2:03 PM". The year is only spelled
 * out on threads from a previous one, where it is the part that disambiguates.
 */
function timeLabel(createdAt: number): string {
	const date = new Date(createdAt)
	const sameYear = date.getFullYear() === new Date().getFullYear()
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
		hour: "numeric",
		minute: "2-digit",
	})
}

/**
 * Assistant-message actions, revealed on hover of the enclosing `Message` row,
 * with the turn's timestamp beside them. Deliberately limited to what
 * `useMapleChat` exposes: just `sendMessage`, so there is no retry or stop to
 * offer here.
 */
export function MessageActions({ message, permalink }: MessageActionsProps) {
	const text = messageText(message)
	const createdAt = message.createdAt
	if (!text && !permalink && createdAt === undefined) return null

	return (
		// The row is hover-revealed but always occupies height, so it sets the gap between a
		// reply and the turn after it. Sized down from the default icon button: 28px of
		// permanently empty space under every one-line answer is what made short exchanges
		// read as spaced-out.
		<div className="-my-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
			{text ? (
				<CopyButton
					value={text}
					label="Message"
					size="icon-xs"
					iconSize={12}
					className="size-5"
					toast={false}
				/>
			) : null}
			{permalink ? (
				<CopyButton
					value={permalink}
					label="Link to message"
					idleIcon={LinkIcon}
					size="icon-xs"
					iconSize={12}
					className="size-5"
					toast={false}
				/>
			) : null}
			{createdAt === undefined ? null : (
				<time
					dateTime={new Date(createdAt).toISOString()}
					title={new Date(createdAt).toLocaleString()}
					className="ml-1 text-[11px] text-muted-foreground tabular-nums"
				>
					{timeLabel(createdAt)}
				</time>
			)}
		</div>
	)
}
