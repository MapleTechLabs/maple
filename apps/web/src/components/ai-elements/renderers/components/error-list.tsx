import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { Badge } from "@maple/ui/components/ui/badge"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import type { RendererComponentProps } from "./types"

interface ErrorListProps {
	errors: Array<{
		errorType: string
		count: number
		affectedServices: string[]
		lastSeen: string
	}>
}

export function ErrorList({ props }: RendererComponentProps<ErrorListProps>) {
	const { errors } = props

	return (
		<div className="max-h-[300px] space-y-1 overflow-y-auto">
			{errors.map((err) => {
				const timeAgo = formatRelativeTime(err.lastSeen)
				return (
					<div
						key={err.errorType}
						className="flex items-start gap-2 rounded p-1 text-2xs hover:bg-muted/50"
					>
						<TruncatedText className="flex-1 text-severity-error">{err.errorType}</TruncatedText>
						<Badge size="xs" mono className={TONE_SOFT.crit}>
							{err.count}
						</Badge>
						<div className="flex shrink-0 gap-1">
							{err.affectedServices.slice(0, 2).map((svc) => (
								<Badge key={svc} variant="muted" size="xs">
									{svc}
								</Badge>
							))}
							{err.affectedServices.length > 2 && (
								<span className="text-3xs text-muted-foreground">
									+{err.affectedServices.length - 2}
								</span>
							)}
						</div>
						<span className="shrink-0 text-3xs text-muted-foreground">{timeAgo}</span>
					</div>
				)
			})}
		</div>
	)
}
