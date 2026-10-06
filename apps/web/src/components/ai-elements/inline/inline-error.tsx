import type { InlineErrorData } from "@maple/domain/chat-annotations"
import { formatNumber } from "@maple/ui/lib/format"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { CircleWarningIcon } from "@/components/icons"
import {
	INLINE_CARD_META,
	INLINE_CARD_ROW,
	InlineMetric,
	InlineServiceChips,
	inlineCardClass,
} from "./inline-card"

/**
 * An error fingerprint. Not a link: the model reports the *message*, and Maple's
 * error pages are keyed by fingerprint, so there is nowhere honest to navigate to.
 */
export function InlineError({ data }: { data: InlineErrorData }) {
	const services = data.affectedServices ?? []
	return (
		<div className={inlineCardClass()}>
			<div className={INLINE_CARD_ROW}>
				<CircleWarningIcon className="size-3.5 shrink-0 text-severity-error" />
				{/* Truncation is the browser's job. Cutting the string at 80 characters put an
				    ellipsis mid-word regardless of how much room the card actually had. */}
				<TruncatedText text={data.errorType} className="flex-1 text-xs text-foreground">
					{data.errorType}
				</TruncatedText>
				{data.count != null && (
					<InlineMetric width="min-w-12" unit="events" tone="text-severity-error">
						{formatNumber(data.count)}
					</InlineMetric>
				)}
			</div>
			{services.length > 0 && (
				<div className={INLINE_CARD_META}>
					<InlineServiceChips services={services} />
				</div>
			)}
		</div>
	)
}
