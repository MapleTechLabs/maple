import type { AttrMap, RuleRecord } from "./engine"

// Warehouse rows to rule records, for previews over recent data. Stored attributes are
// strings, so a preview cannot tell `3` from `"3"`; conditions compare strings anyway.

export interface LogSample {
	readonly serviceName: string
	readonly body: string
	readonly severityNumber: number
	readonly severityText: string
	readonly traceId: string
	readonly logAttributes: Readonly<Record<string, string>>
	readonly resourceAttributes: Readonly<Record<string, string>>
}

export interface SpanSample {
	readonly serviceName: string
	readonly spanName: string
	readonly spanKind?: string
	readonly statusCode: string
	readonly traceId: string
	readonly spanAttributes: Readonly<Record<string, string>>
	readonly resourceAttributes: Readonly<Record<string, string>>
}

const withService = (resource: Readonly<Record<string, string>>, serviceName: string): AttrMap =>
	"service.name" in resource || serviceName === "" ? resource : { ...resource, "service.name": serviceName }

/** `Server`, `SPAN_KIND_SERVER` and `server` all mean the same kind. */
const spanKindName = (raw: string | undefined) => raw?.toLowerCase().replace(/^span_kind_/, "")

export const logSampleToRecord = (row: LogSample): RuleRecord => ({
	signal: "logs",
	resource: withService(row.resourceAttributes, row.serviceName),
	attributes: row.logAttributes,
	body: row.body,
	severityNumber: row.severityNumber,
	severityText: row.severityText,
	traceId: row.traceId,
})

export const spanSampleToRecord = (row: SpanSample): RuleRecord => ({
	signal: "traces",
	resource: withService(row.resourceAttributes, row.serviceName),
	attributes: row.spanAttributes,
	name: row.spanName,
	spanKind: spanKindName(row.spanKind),
	spanStatus: row.statusCode.toLowerCase(),
	traceId: row.traceId,
})
