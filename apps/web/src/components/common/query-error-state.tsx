import { formatBackendError } from "@/lib/error-messages"

interface QueryErrorStateProps {
	error: unknown
	className?: string
	titleOverride?: string
}

export function QueryErrorState({ error, className, titleOverride }: QueryErrorStateProps) {
	const { title, description } = formatBackendError(error)

	return (
		<div
			className={
				className ??
				"rounded-md border border-destructive/50 bg-destructive/10 p-8 flex flex-col gap-1"
			}
		>
			<p className="font-medium text-destructive">{titleOverride ?? title}</p>
			<p className="text-xs text-destructive/80 whitespace-pre-wrap">{description}</p>
		</div>
	)
}

