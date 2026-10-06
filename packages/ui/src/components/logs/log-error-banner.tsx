import { ErrorSection } from "../error-section"

/** The fields the banner reads; both the web and local log shapes satisfy it. */
export interface LogErrorBannerLog {
	readonly body?: string
	readonly severityText: string
	readonly serviceName: string
	readonly logAttributes: Record<string, string>
}

function getErrorMessage(log: LogErrorBannerLog): string {
	return log.logAttributes["exception.message"] ?? log.logAttributes["error.message"] ?? log.body ?? ""
}

export function LogErrorBanner({ log }: { log: LogErrorBannerLog }) {
	const message = getErrorMessage(log)
	if (!message) return null

	return (
		<ErrorSection
			message={message}
			title={log.severityText.toUpperCase() === "FATAL" ? "Fatal" : "Error"}
			badge={log.logAttributes["exception.type"] ?? log.logAttributes["error.type"]}
			prompt={{ serviceName: log.serviceName, attributes: log.logAttributes }}
		/>
	)
}
