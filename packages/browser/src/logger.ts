import { emitLog, type LogAttributeValue, Severity } from "./logs"

type LogMethod = (message: string, attributes?: Readonly<Record<string, LogAttributeValue>>) => void

export interface MapleLogger {
	readonly debug: LogMethod
	readonly info: LogMethod
	readonly warn: LogMethod
	readonly error: LogMethod
}

const method =
	(level: keyof typeof Severity): LogMethod =>
	(message, attributes) => {
		// Logging must never throw into the host app.
		try {
			emitLog({
				severityNumber: Severity[level],
				severityText: level,
				body: String(message),
				attributes,
			})
		} catch {}
	}

export const logger: MapleLogger = {
	debug: method("DEBUG"),
	info: method("INFO"),
	warn: method("WARN"),
	error: method("ERROR"),
}
