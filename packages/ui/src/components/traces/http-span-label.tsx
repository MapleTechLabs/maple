import { getHttpInfo, HTTP_METHOD_COLORS } from "../../lib/http"
import { cn } from "../../lib/utils"

interface HttpSpanLabelProps {
	spanName: string
	spanAttributes?: Record<string, string>
	spanKind?: string
	className?: string
	textClassName?: string
}

export function HttpSpanLabel({ spanName, spanAttributes, spanKind, className, textClassName }: HttpSpanLabelProps) {
	const httpInfo = getHttpInfo({ spanName, spanAttributes, spanKind })

	if (!httpInfo) {
		return (
			<span className={cn("truncate", className, textClassName)} title={spanName}>
				{spanName}
			</span>
		)
	}

	const isClient = httpInfo.kind === "client"

	return (
		<span
			className={cn("flex min-w-0 items-center gap-1.5 font-mono", className)}
			title={`${isClient ? "Outgoing → " : ""}${httpInfo.route || spanName}`}
		>
			<span
				className={cn(
					"shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-bold leading-none text-white",
					HTTP_METHOD_COLORS[httpInfo.method] || "bg-[#5A5248]",
				)}
			>
				{isClient && (
					<svg
						viewBox="0 0 10 10"
						aria-label="outgoing request"
						className="size-2.5 -ml-0.5 opacity-90"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="square"
						strokeLinejoin="miter"
					>
						<path d="M3 7L7 3" />
						<path d="M4 3H7V6" />
					</svg>
				)}
				{httpInfo.method}
			</span>
			<span className={cn("truncate", textClassName)}>{httpInfo.route || spanName}</span>
		</span>
	)
}
