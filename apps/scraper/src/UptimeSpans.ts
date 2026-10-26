import { Array as Arr, Option } from "effect"
import type { UptimeProbeTarget } from "@maple/domain/uptime"
import type { CheckTraceContext, ProbeOutcome } from "./UptimeProbe"

/** Everything one check span needs; buffered until the org's next flush. */
export interface UptimeCheckSpan {
	readonly ingestKey: string
	readonly monitor: Pick<UptimeProbeTarget, "id" | "name" | "serviceName" | "config">
	readonly trace: CheckTraceContext
	readonly startedAtMs: number
	readonly endedAtMs: number
	readonly outcome: ProbeOutcome
}

export type OtlpAnyValue =
	| { readonly stringValue: string }
	| { readonly boolValue: boolean }
	| { readonly intValue: string }
	| { readonly doubleValue: number }

export interface OtlpKeyValue {
	readonly key: string
	readonly value: OtlpAnyValue
}

export interface OtlpSpan {
	readonly traceId: string
	readonly spanId: string
	readonly name: string
	/** 3 = SPAN_KIND_CLIENT. */
	readonly kind: 3
	readonly startTimeUnixNano: string
	readonly endTimeUnixNano: string
	readonly attributes: ReadonlyArray<OtlpKeyValue>
	/** 1 = STATUS_CODE_OK, 2 = STATUS_CODE_ERROR. */
	readonly status: { readonly code: 1 | 2; readonly message?: string }
}

export interface OtlpTraceExportRequest {
	readonly resourceSpans: ReadonlyArray<{
		readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> }
		readonly scopeSpans: ReadonlyArray<{
			readonly scope: { readonly name: string; readonly version: string }
			readonly spans: ReadonlyArray<OtlpSpan>
		}>
	}>
}

export const UPTIME_SERVICE_NAME = "maple-uptime"
const SCOPE = { name: "maple-uptime", version: "1.0" } as const

const anyValue = (value: string | number | boolean): OtlpAnyValue => {
	if (typeof value === "string") return { stringValue: value }
	if (typeof value === "boolean") return { boolValue: value }
	return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
}

const keyValues = (attributes: Readonly<Record<string, string | number | boolean>>) =>
	Object.entries(attributes).map(([key, value]): OtlpKeyValue => ({ key, value: anyValue(value) }))

/** Epoch ms as the decimal-string nanos OTLP/JSON uses; BigInt because ns overflow 2^53. */
export const toUnixNano = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString()

const parseUrl = (raw: string): Option.Option<URL> => Option.liftThrowable(() => new URL(raw))()

/** `GET /checkout/health`, `TCP db.example.com:5432`, `DNS A example.com`. */
export const checkSpanName = (config: UptimeCheckSpan["monitor"]["config"]): string => {
	switch (config._tag) {
		case "http":
			return Option.match(parseUrl(config.url), {
				onNone: () => config.method,
				onSome: (url) => `${config.method} ${url.pathname}`,
			})
		case "tcp":
			return `TCP ${config.host}:${config.port}`
		case "dns":
			return `DNS ${config.recordType} ${config.hostname}`
	}
}

const targetAttributes = (
	config: UptimeCheckSpan["monitor"]["config"],
): Record<string, string | number | boolean> => {
	switch (config._tag) {
		case "http":
			return Option.match(parseUrl(config.url), {
				onNone: () => ({ "url.full": config.url, "http.request.method": config.method }),
				onSome: (url) => ({
					"url.full": config.url,
					"http.request.method": config.method,
					"server.address": url.hostname,
					"server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
					"network.transport": "tcp",
				}),
			})
		case "tcp":
			return { "server.address": config.host, "server.port": config.port, "network.transport": "tcp" }
		case "dns":
			return {
				"dns.question.name": config.hostname,
				"maple.uptime.dns.record_type": config.recordType,
				"network.transport": "udp",
			}
	}
}

/** One CLIENT span for a check, ids equal to the `traceparent` the target saw. */
export const toOtlpSpan = (check: UptimeCheckSpan): OtlpSpan => {
	const { outcome } = check
	return {
		traceId: check.trace.traceId,
		spanId: check.trace.spanId,
		name: checkSpanName(check.monitor.config),
		kind: 3,
		startTimeUnixNano: toUnixNano(check.startedAtMs),
		endTimeUnixNano: toUnixNano(check.endedAtMs),
		attributes: keyValues({
			...targetAttributes(check.monitor.config),
			"maple.uptime.kind": check.monitor.config._tag,
			"maple.uptime.ok": outcome.ok,
			...(outcome.statusCode === null
				? undefined
				: { "http.response.status_code": outcome.statusCode }),
			...(outcome.errorType === null ? undefined : { "error.type": outcome.errorType }),
			...(outcome.error === null ? undefined : { "maple.uptime.failure": outcome.error }),
		}),
		status: outcome.ok ? { code: 1 } : { code: 2, message: outcome.error ?? "Check failed" },
	}
}

const resourceAttributes = (monitor: UptimeCheckSpan["monitor"]) =>
	keyValues({
		"service.name": UPTIME_SERVICE_NAME,
		"maple.uptime.monitor_id": monitor.id,
		"maple.uptime.monitor_name": monitor.name,
		...(monitor.serviceName === null ? undefined : { "maple.uptime.service_name": monitor.serviceName }),
	})

/** One export request; checks of the same monitor share a resource. */
export const encodeTraceExport = (checks: ReadonlyArray<UptimeCheckSpan>): OtlpTraceExportRequest => {
	const byMonitor = Arr.groupBy(checks, (check) => check.monitor.id)
	return {
		resourceSpans: Object.values(byMonitor).map((group) => ({
			// The newest check names the resource, so a rename shows up at once.
			resource: { attributes: resourceAttributes(Arr.lastNonEmpty(group).monitor) },
			scopeSpans: [{ scope: SCOPE, spans: group.map(toOtlpSpan) }],
		})),
	}
}
