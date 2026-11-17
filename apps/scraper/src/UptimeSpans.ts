import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import {
	MAPLE_SERVICES_NAMESPACE,
	UPTIME_MONITOR_ID_ATTRIBUTE,
	UPTIME_SERVICE_NAME,
	UPTIME_TIMING_ATTRIBUTES,
	type UptimeProbeTarget,
} from "@maple/domain/uptime"
import type { PhaseTimings } from "./UptimePhases"
import type { CheckTraceContext, ProbeOutcome, UptimeStepRun } from "./UptimeProbe"

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
	/** Absent on the check's root span; a multi-step check's steps carry it. */
	readonly parentSpanId?: string
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

const SCOPE = { name: UPTIME_SERVICE_NAME, version: "1.0" } as const

const anyValue = (value: string | number | boolean): OtlpAnyValue => {
	if (typeof value === "string") return { stringValue: value }
	if (typeof value === "boolean") return { boolValue: value }
	return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
}

const keyValues = (attributes: Readonly<Record<string, string | number | boolean>>) =>
	Arr.map(Rec.toEntries(attributes), ([key, value]): OtlpKeyValue => ({ key, value: anyValue(value) }))

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
		case "multistep":
			return `Multi-step check (${config.steps.length} ${config.steps.length === 1 ? "step" : "steps"})`
	}
}

const targetAttributes = (
	config: UptimeCheckSpan["monitor"]["config"],
): Record<string, string | number | boolean> => {
	switch (config._tag) {
		case "http":
			// The query and fragment may carry credentials, so the span keeps scheme, host and path.
			return Option.match(parseUrl(config.url), {
				onNone: () => ({
					"url.full": Str.split(/[?#]/u)(config.url)[0] ?? "",
					"http.request.method": config.method,
				}),
				onSome: (url) => ({
					"url.full": `${url.origin}${url.pathname}`,
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
		case "multistep":
			return { "maple.uptime.step_count": config.steps.length }
	}
}

const PHASE_FIELDS = ["dnsMs", "connectMs", "tlsMs", "ttfbMs", "transferMs"] as const satisfies ReadonlyArray<
	keyof PhaseTimings
>

/** An HTTP check's phases in ms to 0.1 ms; a phase that did not happen has no attribute. */
export const timingAttributes = (timings: PhaseTimings | undefined): Record<string, number> =>
	Rec.fromEntries(
		Arr.flatMap(PHASE_FIELDS, (field) => {
			const value = timings?.[field] ?? null
			return value === null ? [] : [[UPTIME_TIMING_ATTRIBUTES[field], Math.round(value * 10) / 10]]
		}),
	)

/** OTel `tls.server.*` attributes of the certificate the target presented; names are written as DNs. */
export const certificateAttributes = (certificate: ProbeOutcome["certificate"]): Record<string, string> =>
	certificate === undefined
		? {}
		: {
				"tls.server.not_after": new Date(certificate.expiresAt).toISOString(),
				...(certificate.subject === ""
					? undefined
					: { "tls.server.subject": `CN=${certificate.subject}` }),
				...(certificate.issuer === ""
					? undefined
					: { "tls.server.issuer": `CN=${certificate.issuer}` }),
			}

/** A step's configured URL without its query or fragment, braces of `{{name}}` kept readable. */
const stepTarget = (template: string): Record<string, string | number> =>
	Option.match(parseUrl(template), {
		onNone: () => ({ "url.full": Str.split(/[?#]/u)(template)[0] ?? "" }),
		onSome: (url) => ({
			"url.full": readableBraces(`${url.origin}${url.pathname}`),
			"server.address": url.hostname,
			"server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
		}),
	})

/** The URL parser escapes `{{name}}` in a path; a span shows it as written. */
const readableBraces = (text: string): string => Str.replaceAll("%7D", "}")(Str.replaceAll("%7B", "{")(text))

/** A multi-step check's step as a CLIENT child of the check span, ids equal to its `traceparent`. */
export const toStepSpan = (check: UptimeCheckSpan, step: UptimeStepRun, index: number): OtlpSpan => {
	const { outcome } = step
	const path = Option.map(parseUrl(step.url), (url) => readableBraces(url.pathname))
	return {
		traceId: check.trace.traceId,
		spanId: step.spanId,
		parentSpanId: check.trace.spanId,
		name: Option.match(path, {
			onNone: () => step.name,
			onSome: (pathname) => `${step.method} ${pathname}`,
		}),
		kind: 3,
		startTimeUnixNano: toUnixNano(step.startedAtMs),
		endTimeUnixNano: toUnixNano(step.endedAtMs),
		attributes: keyValues({
			...stepTarget(step.url),
			"http.request.method": step.method,
			"maple.uptime.step.name": step.name,
			"maple.uptime.step.index": index + 1,
			"maple.uptime.ok": outcome.ok,
			...(outcome.statusCode === null
				? undefined
				: { "http.response.status_code": outcome.statusCode }),
			...(outcome.errorType === null ? undefined : { "error.type": outcome.errorType }),
			...(outcome.error === null ? undefined : { "maple.uptime.failure": outcome.error }),
			...timingAttributes(outcome.timings),
			...certificateAttributes(outcome.certificate),
		}),
		status: outcome.ok ? { code: 1 } : { code: 2, message: outcome.error ?? "Step failed" },
	}
}

/** The check's spans: its own, then one per step of a multi-step check. */
export const toOtlpSpans = (check: UptimeCheckSpan): ReadonlyArray<OtlpSpan> => [
	toOtlpSpan(check),
	...Arr.map(check.outcome.steps ?? [], (step, index) => toStepSpan(check, step, index)),
]

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
			...(outcome.retriedAfter === undefined
				? undefined
				: { "maple.uptime.retried_after": outcome.retriedAfter }),
			...timingAttributes(outcome.timings),
			...certificateAttributes(outcome.certificate),
		}),
		status: outcome.ok ? { code: 1 } : { code: 2, message: outcome.error ?? "Check failed" },
	}
}

const resourceAttributes = (monitor: UptimeCheckSpan["monitor"]) =>
	keyValues({
		"service.name": UPTIME_SERVICE_NAME,
		"service.namespace": MAPLE_SERVICES_NAMESPACE,
		[UPTIME_MONITOR_ID_ATTRIBUTE]: monitor.id,
		"maple.uptime.monitor_name": monitor.name,
		...(monitor.serviceName === null ? undefined : { "maple.uptime.service_name": monitor.serviceName }),
	})

/** One export request; checks of the same monitor share a resource. */
export const encodeTraceExport = (checks: ReadonlyArray<UptimeCheckSpan>): OtlpTraceExportRequest => {
	const byMonitor = Arr.groupBy(checks, (check) => check.monitor.id)
	return {
		resourceSpans: Arr.map(Rec.values(byMonitor), (group) => ({
			// The newest check names the resource, so a rename shows up at once.
			resource: { attributes: resourceAttributes(Arr.lastNonEmpty(group).monitor) },
			scopeSpans: [{ scope: SCOPE, spans: Arr.flatMap(group, toOtlpSpans) }],
		})),
	}
}
