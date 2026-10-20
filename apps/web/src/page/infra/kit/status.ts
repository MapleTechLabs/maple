import { deriveHostStatus, type HostStatus } from "../../../components/infra/format"
import { STATUS_DOT, STATUS_RING, statusLabel } from "../../../components/infra/severity-tokens"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// `SeverityDot` and `HostStatusBadge`.

export const severityDot = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ status: HostStatus; size?: "sm" | "md"; label?: string; className?: string }>,
): Html => {
	const isSmall = (options.size ?? "sm") === "sm"
	return h.span(
		[
			h.Class(
				cn(
					"relative inline-flex items-center justify-center rounded-full ring-1 ring-inset",
					isSmall ? "size-2.5" : "size-3",
					STATUS_RING[options.status],
					options.className,
				),
			),
		],
		[
			h.span([
				h.Class(
					cn("relative rounded-full", isSmall ? "size-1.5" : "size-2", STATUS_DOT[options.status]),
				),
			]),
			...(options.label ? [h.span([h.Class("sr-only")], [options.label])] : []),
		],
	)
}

const STATUS_TEXT = new Map<HostStatus, string>([
	["active", TONE_TEXT.ok],
	["idle", "text-muted-foreground"],
	["ended", "text-muted-foreground"],
])

/** `HostStatusBadge`; `quiet` renders nothing while active. `referenceMs` replaces `Date.now()`. */
export const hostStatusBadge = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		lastSeen: string
		referenceMs: number | string
		quiet?: boolean
		className?: string
	}>,
): Html | null => {
	const status = deriveHostStatus(options.lastSeen, options.referenceMs)
	if (options.quiet === true && status === "active") return null
	return h.span(
		[
			h.Class(
				cn(
					"inline-flex items-center gap-1.5 text-2xs font-medium",
					STATUS_TEXT.get(status),
					options.className,
				),
			),
		],
		[severityDot(h, { status }), statusLabel(status)],
	)
}
