import { AttachmentCard, attachmentId } from "./investigation-attachment-card"
import type { WidgetFixContext } from "./widget-fix-context"

interface WidgetFixAttachmentCardProps {
	ctx: WidgetFixContext
	className?: string
}

export function WidgetFixAttachmentCard({ ctx, className }: WidgetFixAttachmentCardProps) {
	return (
		<AttachmentCard
			className={className}
			stripe="bg-severity-error"
			tint="bg-severity-error/[0.04]"
			meta={[
				<span key="kind" className="font-medium">
					Broken widget
				</span>,
				<span key="id" className="font-mono normal-case tracking-normal">
					{attachmentId(ctx.dashboardId)}/{attachmentId(ctx.widgetId)}
				</span>,
			]}
			title={ctx.widgetTitle || "Untitled widget"}
		>
			{(ctx.errorTitle || ctx.errorMessage) && (
				<div className="mt-2 space-y-0.5">
					{ctx.errorTitle && (
						<div className="text-[11px] font-medium text-severity-error">{ctx.errorTitle}</div>
					)}
					{ctx.errorMessage && (
						<div className="text-[11px] text-severity-error/80 line-clamp-2">
							{ctx.errorMessage}
						</div>
					)}
				</div>
			)}
		</AttachmentCard>
	)
}
