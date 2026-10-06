import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"

import { CircleWarningIcon } from "@/components/icons"
import type { WidgetAlertPrefillNotice } from "@/lib/alerts/widget-prefill"

export function WidgetPrefillNoticeBanner({ notices }: { notices: WidgetAlertPrefillNotice[] }) {
	if (notices.length === 0) return null
	const hasError = notices.some((notice) => notice.severity === "error")
	return (
		<Alert variant={hasError ? "crit" : "warn"} className="rounded-md">
			<CircleWarningIcon size={14} />
			<AlertTitle>Review chart alert draft</AlertTitle>
			<AlertDescription>
				<div className="space-y-1">
					{notices.map((notice) => (
						<p key={notice.message}>{notice.message}</p>
					))}
				</div>
			</AlertDescription>
		</Alert>
	)
}
