import { consentAllowedSince, hasConsent, ingestHeaders, sdkHint } from "@maple/browser-session"
import { ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
	BatchLogRecordProcessor,
	LoggerProvider,
	type LogRecordExporter,
	type ReadableLogRecord,
} from "@opentelemetry/sdk-logs"
import type { ResolvedConfig } from "../config"
import { attachLogSink, detachLogSink } from "../logs"
import { resourceAttributes } from "../tracing"
import { SDK_NAME, SDK_VERSION } from "../version"

/** Same rule as spans: drop records made while consent was absent, even if it is granted by flush time. */
class ConsentLogExporter implements LogRecordExporter {
	constructor(private readonly inner: LogRecordExporter) {}

	export(logs: ReadableLogRecord[], callback: (result: { code: number; error?: Error }) => void): void {
		const since = consentAllowedSince()
		const eligible =
			hasConsent() && Number.isFinite(since)
				? logs.filter((log) => log.hrTime[0] * 1_000 + log.hrTime[1] / 1_000_000 >= since)
				: []
		if (eligible.length === 0) {
			callback({ code: 0 })
			return
		}
		this.inner.export(eligible, callback)
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve()
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown()
	}
}

/** Hands batches the exporter gave up on to the offline queue. */
class OfflineLogExporter implements LogRecordExporter {
	constructor(
		private readonly inner: LogRecordExporter,
		private readonly stash: (logs: ReadableLogRecord[]) => void,
	) {}

	export(logs: ReadableLogRecord[], callback: (result: { code: number; error?: Error }) => void): void {
		this.inner.export(logs, (result) => {
			if (result.code !== 0) this.stash(logs)
			callback(result)
		})
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve()
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown()
	}
}

/** Start the OTel logs pipeline and drain the eager queue into it. Returns a shutdown. */
export function startLogs(
	config: ResolvedConfig,
	stashOffline?: (logs: ReadableLogRecord[]) => void,
): () => Promise<void> {
	const otlp = new OTLPLogExporter({
		url: `${config.endpoint}/v1/logs`,
		headers: ingestHeaders({ ingestKey: config.ingestKey, sdk: sdkHint(SDK_NAME, SDK_VERSION) }),
	})
	const exporter = new ConsentLogExporter(stashOffline ? new OfflineLogExporter(otlp, stashOffline) : otlp)
	// The browser processor flushes on `visibilitychange → hidden` and `pagehide` itself.
	const provider = new LoggerProvider({
		resource: resourceFromAttributes(resourceAttributes(config)),
		processors: [new BatchLogRecordProcessor({ exporter, scheduledDelayMillis: 2_000 })],
	})
	const logger = provider.getLogger(SDK_NAME, SDK_VERSION)
	attachLogSink((record) =>
		logger.emit({
			eventName: record.eventName,
			severityNumber: record.severityNumber,
			severityText: record.severityText,
			body: record.body,
			attributes: record.attributes,
			timestamp: record.timestamp,
			context: record.link ? trace.setSpanContext(ROOT_CONTEXT, record.link) : ROOT_CONTEXT,
		}),
	)
	return async () => {
		detachLogSink()
		await provider.shutdown()
	}
}
