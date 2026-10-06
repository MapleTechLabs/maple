import { httpStatusTone } from "../lib/http"
import { TONE_SOFT, TONE_TEXT } from "../lib/tone"
import { cn } from "../lib/utils"

/** An HTTP status code, toned by class (5xx red, 4xx amber). `badge` adds a tinted chip. */
export function HttpStatusCode({
	code,
	variant = "text",
	className,
}: {
	code: number | null | undefined
	variant?: "text" | "badge"
	className?: string
}) {
	if (code == null) return null
	const tone = httpStatusTone(code)
	return (
		<span
			className={cn(
				"font-mono tabular-nums",
				variant === "badge"
					? cn("rounded-sm px-1 py-px text-[10px]", TONE_SOFT[tone])
					: tone === "neutral"
						? "text-muted-foreground"
						: TONE_TEXT[tone],
				className,
			)}
		>
			{code}
		</span>
	)
}
