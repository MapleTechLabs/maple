// Batches the exporters gave up on, stored in IndexedDB as the same OTLP JSON
// the exporters send, and sent again when the browser is back online or on the
// next page load. Best-effort: a private window or blocked storage just means
// nothing is kept.
import {
	consentAllowedSince,
	hasConsent,
	ingestHeaders,
	onConsentChange,
	sdkHint,
} from "@maple/browser-session"
import { JsonLogsSerializer, JsonTraceSerializer } from "@opentelemetry/otlp-transformer"
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import type { ResolvedConfig } from "../config"
import { SDK_NAME, SDK_VERSION } from "../version"

const DB_NAME = "maple-offline"
const STORE = "batches"
const MAX_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_BATCHES = 100

type Signal = "traces" | "logs"

interface StoredBatch {
	readonly id?: number
	readonly signal: Signal
	readonly body: Uint8Array
	readonly createdAt: number
}

const isStoredBatch = (value: unknown): value is StoredBatch & { readonly id: number } =>
	typeof value === "object" &&
	value !== null &&
	"id" in value &&
	typeof value.id === "number" &&
	"signal" in value &&
	(value.signal === "traces" || value.signal === "logs") &&
	"body" in value &&
	value.body instanceof Uint8Array &&
	"createdAt" in value &&
	typeof value.createdAt === "number"

const settle = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})

function openDb(): Promise<IDBDatabase | undefined> {
	if (typeof indexedDB === "undefined") return Promise.resolve(undefined)
	const request = indexedDB.open(DB_NAME, 1)
	request.onupgradeneeded = () => {
		request.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true })
	}
	return settle(request).catch(() => undefined)
}

export interface OfflineQueue {
	readonly stashSpans: (spans: ReadableSpan[]) => void
	readonly stashLogs: (logs: ReadableLogRecord[]) => void
	/** Send what is stored, oldest first. Stops at the first failure. */
	readonly resend: () => Promise<void>
	readonly stop: () => void
}

export function startOfflineQueue(config: ResolvedConfig): OfflineQueue {
	const db = openDb()
	const headers = {
		...ingestHeaders({ ingestKey: config.ingestKey, sdk: sdkHint(SDK_NAME, SDK_VERSION) }),
		"Content-Type": "application/json",
	}
	const store = async (mode: IDBTransactionMode): Promise<IDBObjectStore | undefined> =>
		(await db)?.transaction(STORE, mode).objectStore(STORE)

	const add = async (signal: Signal, body: Uint8Array | undefined): Promise<void> => {
		if (!body || !hasConsent()) return
		const batches = await store("readwrite")
		if (!batches) return
		await settle(batches.add({ signal, body, createdAt: Date.now() } satisfies StoredBatch))
		const keys = await settle(batches.getAllKeys())
		for (const key of keys.slice(0, Math.max(0, keys.length - MAX_BATCHES)))
			await settle(batches.delete(key))
	}

	/** Send what is stored, oldest first. Stops at the first failure, keeping the rest. */
	const drain = async (): Promise<void> => {
		const read = await store("readonly")
		const stored = read ? (await settle(read.getAll())).filter(isStoredBatch) : []
		for (const batch of stored) {
			// Expired, or captured before the current consent grant (a revoke this queue never saw): drop it.
			if (Date.now() - batch.createdAt <= MAX_AGE_MS && batch.createdAt >= consentAllowedSince()) {
				const response = await fetch(`${config.endpoint}/v1/${batch.signal}`, {
					method: "POST",
					headers,
					body: new Uint8Array(batch.body),
				}).catch(() => undefined)
				// Offline again, or ingest is down: keep the rest for next time.
				if (!response || response.status >= 500 || response.status === 429) return
			}
			const write = await store("readwrite")
			if (write) await settle(write.delete(batch.id))
		}
	}

	/** The resend in flight: a second call joins it rather than returning before it is done. */
	let inflight: Promise<void> | undefined
	const run = async (): Promise<void> => {
		try {
			// The store is shared by every tab of the origin: tabs drain it in turn, and a
			// later one finds what an earlier one sent already deleted.
			if (typeof navigator !== "undefined" && navigator.locks) {
				await navigator.locks.request(`${DB_NAME}-resend`, () => drain())
			} else {
				await drain()
			}
		} catch {
			// Storage went away mid-resend; the batches stay for the next attempt.
		}
	}
	const resend = (): Promise<void> => {
		if (!hasConsent() || (typeof navigator !== "undefined" && navigator.onLine === false))
			return Promise.resolve()
		inflight ??= run().finally(() => {
			inflight = undefined
		})
		return inflight
	}

	const clear = async (): Promise<void> => {
		const batches = await store("readwrite")
		if (batches) await settle(batches.clear())
	}

	const onOnline = (): void => void resend()
	window.addEventListener("online", onOnline)
	// Withdrawn consent also withdraws what was kept for later.
	const stopConsent = onConsentChange((allowed) => {
		if (!allowed) void clear().catch(() => {})
	})
	void resend()

	return {
		stashSpans: (spans) => {
			if (spans.length > 0)
				void add("traces", JsonTraceSerializer.serializeRequest(spans)).catch(() => {})
		},
		stashLogs: (logs) => {
			if (logs.length > 0) void add("logs", JsonLogsSerializer.serializeRequest(logs)).catch(() => {})
		},
		resend,
		stop: () => {
			window.removeEventListener("online", onOnline)
			stopConsent()
			void db.then((opened) => opened?.close())
		},
	}
}
