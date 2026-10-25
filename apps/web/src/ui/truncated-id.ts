import { type IdKind, shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { truncatedIdCopyStyles, truncatedIdStyles } from "@maple/ui/styles/ui/truncated-id"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type CopyStatus, copyButton } from "./copy-button"

// Port of packages/ui/src/components/ui/truncated-id.tsx: a shortened id in mono with the full
// value as the native tooltip. `copy` adds the CopyButton; its state lives in the caller's Model.

export interface TruncatedIdOptions<M> {
	readonly value: string
	readonly kind?: IdKind
	readonly length?: number
	readonly ellipsis?: boolean
	/** Trailing copy button for the full value: its status and click Message. */
	readonly copy?: Readonly<{ status: CopyStatus; onClick: M }>
	readonly className?: string
}

export const truncatedId = <M>(h: HtmlBuilder<M>, options: TruncatedIdOptions<M>): Html => {
	const kind = options.kind ?? "generic"
	const copy = options.copy
	const text = h.span(
		[h.Class(cn(truncatedIdStyles, copy === undefined && options.className)), h.Title(options.value)],
		[shortId(options.value, kind, { length: options.length, ellipsis: options.ellipsis })],
	)
	if (copy === undefined) return text
	return h.span(
		[h.Class(cn(truncatedIdCopyStyles, options.className))],
		[
			text,
			copyButton(h, {
				label: kind === "sha" ? "commit SHA" : `${kind} id`,
				size: "icon-xs",
				status: copy.status,
				onClick: copy.onClick,
			}),
		],
	)
}
