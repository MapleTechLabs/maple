import { memo } from "react"
import { cn } from "@maple/ui/lib/utils"
import { MessageResponse } from "./message-response"
import { parseAnnotations, InlineTrace, InlineService, InlineError, InlineLog } from "./inline"

interface RichTextProps {
	children: string
	className?: string
}

export const RichText = memo(
	({ children, className }: RichTextProps) => {
		const segments = parseAnnotations(children)

		// Fast path: no annotations, render as normal MessageResponse
		if (segments.length === 1 && segments[0].type === "text") {
			return <MessageResponse className={className}>{children}</MessageResponse>
		}

		// Cards and prose used to space themselves — the cards with `my-1`, the markdown
		// with its own paragraph margins — so a card next to a paragraph sat 4px from it
		// while two paragraphs sat 16px apart. One flex gap owns the rhythm instead.
		return (
			<div className={cn("flex flex-col gap-2", className)}>
				{segments.map((segment, i) => {
					switch (segment.type) {
						case "text": {
							if (!segment.content.trim()) return null
							return <MessageResponse key={i}>{segment.content}</MessageResponse>
						}
						case "trace":
							return <InlineTrace key={i} data={segment.data} />
						case "service":
							return <InlineService key={i} data={segment.data} />
						case "error":
							return <InlineError key={i} data={segment.data} />
						case "log":
							return <InlineLog key={i} data={segment.data} />
					}
				})}
			</div>
		)
	},
	(prevProps, nextProps) => prevProps.children === nextProps.children,
)

RichText.displayName = "RichText"
