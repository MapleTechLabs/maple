import { CopyButton } from "@maple/ui/components/ui/copy-button"
import type { UIMessage } from "@/components/ai-elements/types"
import { LinkIcon } from "@/components/icons"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

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
 * Assistant-message actions, revealed on hover of the enclosing `Message` row,
 * with the turn's timestamp beside them. Deliberately limited to what
 * `useMapleChat` exposes: just `sendMessage`, so there is no retry or stop to
 * offer here.
 */
export function MessageActions({ message, permalink }: MessageActionsProps) {
	const text = messageText(message)
	const createdAt = message.createdAt
	const { effectiveTimezone } = useTimezonePreference()
	if (!text && !permalink && createdAt === undefined) return null

	return (
		// The row is hover-revealed but always occupies height, so it sets the gap between a
		// reply and the turn after it. Sized down from the default icon button: 28px of
		// permanently empty space under every one-line answer is what made short exchanges
		// read as spaced-out.
		<div className="-my-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
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
					title={formatTimestampInTimezone(createdAt, {
						timeZone: effectiveTimezone,
						withYear: true,
					})}
					className="ml-1 text-2xs text-muted-foreground tabular-nums"
				>
					{formatTimestampInTimezone(createdAt, { timeZone: effectiveTimezone, style: "range" })}
				</time>
			)}
		</div>
	)
}
