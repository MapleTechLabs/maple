import { Fragment, type ReactNode } from "react"
import { Panel } from "@maple/ui/components/ui/panel"
import { cn } from "@maple/ui/lib/utils"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { shortId } from "@maple/ui/lib/ids"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import type { InvestigationContext, InvestigationKind } from "./investigation-context"

const ACCENT: Record<string, { stripe: string; tint: string }> = {
	critical: { stripe: "bg-severity-fatal", tint: "bg-severity-fatal/[0.04]" },
	high: { stripe: "bg-severity-error", tint: "bg-severity-error/[0.04]" },
	warning: { stripe: "bg-severity-warn", tint: "bg-severity-warn/[0.04]" },
	medium: { stripe: "bg-severity-warn", tint: "bg-severity-warn/[0.04]" },
	low: { stripe: "bg-severity-debug", tint: "bg-severity-debug/[0.04]" },
} satisfies Record<string, { stripe: string; tint: string }>

const KIND_LABEL: Record<InvestigationKind, string> = {
	alert: "Attached alert",
	anomaly: "Attached anomaly",
	error: "Attached error",
	freeform: "Investigation subject",
} satisfies Record<InvestigationKind, string>

const STATUS_TONE: Record<string, string> = {
	Firing: TONE_TEXT.crit,
	Open: TONE_TEXT.crit,
	Resolved: TONE_TEXT.info,
} satisfies Record<string, string>

/** The last dash segment of a UUID-ish id, cut to 8 chars: the part that tells ids apart. */
export const attachmentId = (id: string): string =>
	shortId(id.split("-").at(-1) ?? id, "generic", { length: 8 })

/** The pinned-card shell above a chat thread: accent stripe, an eyebrow meta row, a title. */
export function AttachmentCard({
	stripe,
	tint,
	meta,
	title,
	className,
	children,
}: {
	stripe: string
	tint: string
	meta: readonly ReactNode[]
	title: ReactNode
	className?: string
	children?: ReactNode
}) {
	return (
		<div className={cn("mx-auto w-full max-w-3xl px-4 pt-3", className)}>
			<Panel className={cn("relative bg-card/80 backdrop-blur-sm", tint)}>
				<div className={cn("absolute inset-y-0 left-0 w-[3px]", stripe)} aria-hidden />
				<div className="min-w-0 py-2.5 pr-3 pl-3.5">
					<Eyebrow as="div" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-normal">
						{meta.map((item, index) => (
							<Fragment key={index}>
								{index > 0 ? (
									<span
										className="size-0.5 rounded-full bg-muted-foreground/40"
										aria-hidden
									/>
								) : null}
								{item}
							</Fragment>
						))}
					</Eyebrow>
					<div className="mt-1 truncate text-[13px] font-medium text-foreground">{title}</div>
					{children}
				</div>
			</Panel>
		</div>
	)
}

/** Pinned card above the chat thread: the investigation subject, any kind. */
export function InvestigationAttachmentCard({
	ctx,
	className,
}: {
	ctx: InvestigationContext
	className?: string
}) {
	const accent = ACCENT[ctx.severity] ?? { stripe: "bg-muted-foreground", tint: "bg-muted/30" }
	const statusTone = STATUS_TONE[ctx.status] ?? "text-muted-foreground"

	return (
		<AttachmentCard
			className={className}
			stripe={accent.stripe}
			tint={accent.tint}
			meta={[
				<span key="kind" className="font-medium">
					{KIND_LABEL[ctx.kind]}
				</span>,
				<span key="severity" className="font-mono capitalize">
					{ctx.severity}
				</span>,
				<span key="status" className={cn("inline-flex items-center gap-1 font-mono", statusTone)}>
					{ctx.status === "Resolved" ? (
						<StatusDot tone="ok" />
					) : (
						<StatusDot tone="custom" className={accent.stripe} />
					)}
					{ctx.status}
				</span>,
				<span key="id" className="font-mono normal-case tracking-normal">
					#{attachmentId(ctx.id)}
				</span>,
			]}
			title={ctx.title}
		>
			{ctx.facts.length > 0 ? (
				<ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
					{ctx.facts.map((fact) => (
						<li key={fact.key} className="flex min-w-0 flex-col leading-tight">
							<Eyebrow>{fact.label}</Eyebrow>
							<span className="truncate font-mono text-2xs text-foreground">{fact.value}</span>
						</li>
					))}
				</ul>
			) : null}
		</AttachmentCard>
	)
}
