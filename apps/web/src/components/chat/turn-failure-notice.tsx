import type { ReactNode } from "react"
import { cn } from "@maple/ui/lib/utils"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { Alert, AlertAction, AlertDescription } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"

/** The destructive notice above the composer: what failed, and one way to try again. */
export function ChatFailureNotice({
	children,
	actionLabel,
	onAction,
	truncate = false,
	title,
}: {
	children: ReactNode
	actionLabel: string
	onAction: () => void
	/** Two lines at most, for messages that can run long. */
	truncate?: boolean
	/** Full text, for the hover when `truncate` clips it. */
	title?: string
}) {
	return (
		<Alert variant="crit" size="sm" className="mb-3 text-sm">
			<AlertDescription className={cn("min-w-0", TONE_TEXT.crit)} title={title}>
				{truncate ? (
					<span className="line-clamp-2 [overflow-wrap:anywhere]">{children}</span>
				) : (
					children
				)}
			</AlertDescription>
			<AlertAction>
				<Button type="button" size="sm" variant="outline" onClick={onAction}>
					{actionLabel}
				</Button>
			</AlertAction>
		</Alert>
	)
}

interface TurnFailureNoticeProps {
	readonly error: Error
	readonly onContinue: () => void
}

/** An admitted chat turn failed after the user's message reached the server. */
export function TurnFailureNotice({ error, onContinue }: TurnFailureNoticeProps) {
	return (
		<ChatFailureNotice actionLabel="Continue" onAction={onContinue}>
			Response failed: {error.message}
		</ChatFailureNotice>
	)
}
