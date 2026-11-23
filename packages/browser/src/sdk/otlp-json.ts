// OTLP/JSON request bodies, field for field and in the order the OTel JS
// otlp-transformer wrote them: ids as hex, times as decimal nanosecond strings.
// `otlp-wire.test.ts` holds this to goldens captured from that serializer.
import type { AnyValue, Attributes, Link } from "@opentelemetry/api"
import type { ReadableLogRecord } from "./logs"
import type { InstrumentationScope, ReadableSpan, Resource, TimedEvent } from "./span"
import { hrTimeToNanosString } from "./time"

export interface Serializer<T> {
	serializeRequest(items: T[]): Uint8Array | undefined
}

type Json = string | number | boolean | null | undefined | readonly Json[] | { readonly [key: string]: Json }

function base64(bytes: Uint8Array): string {
	return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
}

function anyValue(value: AnyValue): Json {
	if (typeof value === "string") return { stringValue: value }
	if (typeof value === "number")
		return Number.isInteger(value) ? { intValue: value } : { doubleValue: value }
	if (typeof value === "boolean") return { boolValue: value }
	if (value instanceof Uint8Array) return { bytesValue: base64(value) }
	if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } }
	if (typeof value === "object" && value !== null) {
		return {
			kvlistValue: {
				values: Object.entries(value).map(([key, item]) => ({ key, value: anyValue(item) })),
			},
		}
	}
	return {}
}

const attributes = (input: Attributes): Json[] =>
	Object.keys(input).map((key) => ({ key, value: anyValue(input[key]) }))

const resourceOf = (resource: Resource): Json => ({
	attributes: attributes(resource.attributes),
	droppedAttributesCount: 0,
})

const scopeOf = (scope: InstrumentationScope): Json => ({ name: scope.name, version: scope.version })

/** Trace flags, plus the "has is-remote" bit and the is-remote bit itself. */
const spanFlags = (traceFlags: number, isRemote: boolean | undefined): number =>
	(traceFlags & 0xff) | 0x100 | (isRemote ? 0x200 : 0)

const event = (item: TimedEvent): Json => ({
	attributes: item.attributes ? attributes(item.attributes) : [],
	name: item.name,
	timeUnixNano: hrTimeToNanosString(item.time),
	droppedAttributesCount: item.droppedAttributesCount ?? 0,
})

const link = (item: Link): Json => ({
	attributes: item.attributes ? attributes(item.attributes) : [],
	spanId: item.context.spanId,
	traceId: item.context.traceId,
	traceState: item.context.traceState?.serialize(),
	droppedAttributesCount: item.droppedAttributesCount ?? 0,
	flags: spanFlags(item.context.traceFlags, item.context.isRemote),
})

const span = (item: ReadableSpan): Json => {
	const context = item.spanContext()
	return {
		traceId: context.traceId,
		spanId: context.spanId,
		parentSpanId: item.parentSpanContext?.spanId || undefined,
		traceState: context.traceState?.serialize(),
		name: item.name,
		kind: item.kind == null ? 0 : item.kind + 1,
		startTimeUnixNano: hrTimeToNanosString(item.startTime),
		endTimeUnixNano: hrTimeToNanosString(item.endTime),
		attributes: attributes(item.attributes),
		droppedAttributesCount: item.droppedAttributesCount,
		events: item.events.map(event),
		droppedEventsCount: item.droppedEventsCount,
		status: { code: item.status.code, message: item.status.message },
		links: item.links.map(link),
		droppedLinksCount: item.droppedLinksCount,
		flags: spanFlags(context.traceFlags, item.parentSpanContext?.isRemote),
	}
}

/** Group by resource (identity), then by scope, keeping first-seen order. */
function grouped<T, K>(
	items: T[],
	resourceOfItem: (item: T) => Resource,
	scopeKey: (item: T) => K,
): Array<[Resource, T[][]]> {
	const resources = new Map<Resource, Map<K, T[]>>()
	for (const item of items) {
		const resource = resourceOfItem(item)
		const scopes = resources.get(resource) ?? new Map<K, T[]>()
		resources.set(resource, scopes)
		const key = scopeKey(item)
		const list = scopes.get(key) ?? []
		scopes.set(key, list)
		list.push(item)
	}
	return Array.from(resources, ([resource, scopes]) => [resource, [...scopes.values()]])
}

const encode = (request: Json): Uint8Array => new TextEncoder().encode(JSON.stringify(request))

export const JsonTraceSerializer: Serializer<ReadableSpan> = {
	serializeRequest: (spans) =>
		encode({
			resourceSpans: grouped(
				spans,
				(item) => item.resource,
				({ instrumentationScope: scope }) =>
					`${scope.name}@${scope.version || ""}:${scope.schemaUrl || ""}`,
			).map(([resource, scopes]) => ({
				resource: resourceOf(resource),
				scopeSpans: scopes.map((list) => ({
					scope: scopeOf(list[0]?.instrumentationScope ?? { name: "" }),
					spans: list.map(span),
					schemaUrl: list[0]?.instrumentationScope.schemaUrl,
				})),
				schemaUrl: undefined,
			})),
		}),
}

export const JsonLogsSerializer: Serializer<ReadableLogRecord> = {
	serializeRequest: (logs) =>
		encode({
			resourceLogs: grouped(
				logs,
				(item) => item.resource,
				(item) => item.instrumentationScope,
			).map(([resource, scopes]) => ({
				resource: resourceOf(resource),
				scopeLogs: scopes.map((list) => ({
					scope: scopeOf(list[0]?.instrumentationScope ?? { name: "" }),
					logRecords: list.map(logRecord),
					schemaUrl: list[0]?.instrumentationScope.schemaUrl,
				})),
				schemaUrl: undefined,
			})),
		}),
}

const logRecord = (log: ReadableLogRecord): Json => ({
	timeUnixNano: hrTimeToNanosString(log.hrTime),
	observedTimeUnixNano: hrTimeToNanosString(log.hrTimeObserved),
	severityNumber: log.severityNumber,
	severityText: log.severityText,
	body: anyValue(log.body),
	eventName: log.eventName,
	attributes: attributes(log.attributes),
	droppedAttributesCount: log.droppedAttributesCount,
	flags: log.spanContext?.traceFlags,
	traceId: log.spanContext?.traceId,
	spanId: log.spanContext?.spanId,
})
