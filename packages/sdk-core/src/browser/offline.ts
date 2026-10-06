// Batches the exporters gave up on, stored in IndexedDB as the same OTLP JSON
// the exporters send, and sent again when the browser is back online or on the
// next page load. Best-effort: a private window or blocked storage just means
// nothing is kept.
import { consentRevokedAt, hasConsent, onConsentChange } from "@maple/browser-session"

const DB_NAME = "maple-offline"
const STORE = "batches"
const MAX_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_BATCHES = 100

export type OfflineSignal = "traces" | "logs"
type Signal = OfflineSignal

interface StoredBatch {
	readonly id?: number
	readonly signal: Signal
	readonly body: Uint8Array
	readonly createdAt: number
	/** Endpoint plus a fingerprint of the credentials: another SDK on the page may send elsewhere. */
	readonly target?: string
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
	try {
		const request = indexedDB.open(DB_NAME, 1)
		request.onupgradeneeded = () => {
			request.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true })
		}
		return settle(request).catch(() => undefined)
	} catch {
		// Opaque origins (sandboxed iframes, `data:` pages) throw synchronously.
		return Promise.resolve(undefined)
	}
}

/** FNV-1a, hex: identifies the credentials without storing them. */
function fingerprint(value: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16)
}

export interface OfflineQueueOptions {
	/** Ingest base URL; batches are sent to `<endpoint>/v1/<signal>`. */
	readonly endpoint: string
	/** Auth and SDK headers for the resend. */
	readonly headers: Record<string, string>
}

export interface OfflineQueue {
	/** Keep an OTLP JSON request body the exporter gave up on. */
	readonly stash: (signal: OfflineSignal, body: Uint8Array) => void
	/** Send what is stored for this endpoint and key, oldest first. Stops at the first failure. */
	readonly resend: () => Promise<void>
	readonly stop: () => void
}

export function startOfflineQueue(config: OfflineQueueOptions): OfflineQueue {
	const db = openDb()
	const headers = { ...config.headers, "Content-Type": "application/json" }
	const auth = Object.entries(config.headers).find(([name]) => name.toLowerCase() === "authorization")
	const target = `${config.endpoint}|${fingerprint(auth?.[1] ?? "")}`
	const store = async (mode: IDBTransactionMode): Promise<IDBObjectStore | undefined> =>
		(await db)?.transaction(STORE, mode).objectStore(STORE)

	const add = async (signal: Signal, body: Uint8Array, createdAt: number): Promise<void> => {
		// Withdrawn while this write waited its turn: it must not land after the clear.
		if (!hasConsent() || createdAt <= consentRevokedAt()) return
		const batches = await store("readwrite")
		if (!batches) return
		await settle(batches.add({ signal, body, createdAt, target } satisfies StoredBatch))
		const keys = await settle(batches.getAllKeys())
		for (const key of keys.slice(0, Math.max(0, keys.length - MAX_BATCHES)))
			await settle(batches.delete(key))
	}

	/** Send what is stored, oldest first. Stops at the first failure, keeping the rest. */
	const drain = async (): Promise<void> => {
		const read = await store("readonly")
		const stored = read ? (await settle(read.getAll())).filter(isStoredBatch) : []
		for (const batch of stored) {
			// Checked per batch: consent can be withdrawn while an earlier POST is in flight.
			if (!hasConsent()) return
			const expired = Date.now() - batch.createdAt > MAX_AGE_MS
			// Another SDK's batch is left for it, unless it is too old for anyone to send.
			if (!expired && batch.target !== undefined && batch.target !== target) continue
			// Expired, or captured before consent was last withdrawn (a revoke this queue never saw): drop it.
			if (!expired && batch.createdAt > consentRevokedAt()) {
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

	/** Writes in order: a revoke's clear runs after the writes before it, and `stop` closes the database after all of them. */
	let writes: Promise<void> = Promise.resolve()
	const queue = (write: () => Promise<void>): void => {
		writes = writes.then(write).catch(() => {})
	}
	const stash = (signal: Signal, body: Uint8Array | undefined): void => {
		// Stamped now, not when the write runs, so a revoke in between is seen for what it is.
		const createdAt = Date.now()
		if (body && hasConsent()) queue(() => add(signal, body, createdAt))
	}

	const onOnline = (): void => void resend()
	window.addEventListener("online", onOnline)
	// Withdrawn consent also withdraws what was kept for later.
	const stopConsent = onConsentChange((allowed) => {
		// The consent module records the revoke itself, so it holds even where this queue never ran.
		if (!allowed) queue(clear)
	})
	void resend()

	return {
		stash: (signal, body) => {
			if (body.byteLength > 0) stash(signal, body)
		},
		resend,
		stop: () => {
			window.removeEventListener("online", onOnline)
			stopConsent()
			void writes.then(() => db).then((opened) => opened?.close())
		},
	}
}
