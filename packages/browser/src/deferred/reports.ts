// Content Security Policy violations and browser deprecation/intervention
// reports, as WARN log events. They are worth seeing but are not errors in the
// app's code, so they never become issues.
import { scrubUrl } from "@maple/browser-session"
import { emitLog, type LogAttributeValue, Severity } from "../logs"

export interface ReportOptions {
	/** Content Security Policy violations. */
	readonly csp: boolean
	/** Deprecation and intervention reports from the browser. */
	readonly browserReports: boolean
}

/** Repeats of one report (a blocked image in a loop) are sent once per page, up to this many kinds. */
const MAX_REPORTS = 50

/** The report fields this module reads, parsed out of a report body or a DOM event. */
interface ReportFields {
	readonly effectiveDirective?: string | undefined
	readonly blockedURL?: string | undefined
	readonly disposition?: string | undefined
	readonly sourceFile?: string | undefined
	readonly lineNumber?: number | undefined
	readonly columnNumber?: number | undefined
	readonly id?: string | undefined
	readonly message?: string | undefined
}

/** Report bodies expose their fields as getters that only `toJSON` serializes. */
function parseReportBody(body: unknown): ReportFields {
	const raw: unknown = body === null || body === undefined ? undefined : JSON.parse(JSON.stringify(body))
	const fields = new Map(typeof raw === "object" && raw !== null ? Object.entries(raw) : [])
	const str = (key: string): string | undefined => {
		const value = fields.get(key)
		return typeof value === "string" && value !== "" ? value : undefined
	}
	const int = (key: string): number | undefined => {
		const value = fields.get(key)
		return typeof value === "number" && value > 0 ? value : undefined
	}
	return {
		effectiveDirective: str("effectiveDirective") ?? str("violatedDirective"),
		blockedURL: str("blockedURL") ?? str("blockedURI"),
		disposition: str("disposition"),
		sourceFile: str("sourceFile"),
		lineNumber: int("lineNumber"),
		columnNumber: int("columnNumber"),
		id: str("id"),
		message: str("message"),
	}
}

function sourceAttributes(fields: ReportFields): Record<string, LogAttributeValue> {
	return {
		...(fields.sourceFile ? { "code.file.path": scrubUrl(fields.sourceFile) } : undefined),
		...(fields.lineNumber ? { "code.line.number": fields.lineNumber } : undefined),
		...(fields.columnNumber ? { "code.column.number": fields.columnNumber } : undefined),
	}
}

export function startReports(options: ReportOptions): () => void {
	if (!options.csp && !options.browserReports) return () => {}
	const seen = new Set<string>()
	const once = (key: string): boolean => {
		if (seen.has(key) || seen.size >= MAX_REPORTS) return false
		seen.add(key)
		return true
	}

	const csp = (fields: ReportFields): void => {
		const directive = fields.effectiveDirective ?? "unknown"
		const blocked = scrubUrl(fields.blockedURL ?? "inline")
		if (!once(`csp ${directive} ${blocked}`)) return
		emitLog({
			eventName: "maple.browser.csp_violation",
			severityNumber: Severity.WARN,
			severityText: "WARN",
			body: `${directive} blocked ${blocked}`,
			attributes: {
				"maple.csp.effective_directive": directive,
				"maple.csp.blocked_uri": blocked,
				...(fields.disposition ? { "maple.csp.disposition": fields.disposition } : undefined),
				"url.full": scrubUrl(location.href),
				...sourceAttributes(fields),
			},
		})
	}

	const browserReport = (type: string, fields: ReportFields): void => {
		const id = fields.id ?? "unknown"
		if (!once(`${type} ${id}`)) return
		emitLog({
			eventName: "maple.browser.report",
			severityNumber: Severity.WARN,
			severityText: "WARN",
			body: fields.message ?? `${type}: ${id}`,
			attributes: { "maple.report.type": type, "maple.report.id": id, ...sourceAttributes(fields) },
		})
	}

	if (typeof ReportingObserver === "function") {
		const types = [
			...(options.csp ? ["csp-violation"] : []),
			...(options.browserReports ? ["deprecation", "intervention"] : []),
		]
		// Buffered: reports from before this chunk loaded are delivered too.
		const observer = new ReportingObserver(
			(reports) => {
				for (const report of reports) {
					const fields = parseReportBody(report.body)
					if (report.type === "csp-violation") csp(fields)
					else browserReport(report.type ?? "report", fields)
				}
			},
			{ types, buffered: true },
		)
		observer.observe()
		return () => observer.disconnect()
	}
	if (!options.csp) return () => {}
	// No ReportingObserver: CSP violations still fire as a DOM event.
	const onViolation = (event: SecurityPolicyViolationEvent): void =>
		csp({
			effectiveDirective: event.effectiveDirective,
			blockedURL: event.blockedURI || undefined,
			disposition: event.disposition,
			sourceFile: event.sourceFile,
			lineNumber: event.lineNumber,
			columnNumber: event.columnNumber,
		})
	document.addEventListener("securitypolicyviolation", onViolation)
	return () => document.removeEventListener("securitypolicyviolation", onViolation)
}
