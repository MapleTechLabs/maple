import type { ResolvedConfig } from "../config"

// Replay POSTs are best-effort and must never throw into the host app, but a
// fully broken ingest endpoint should not be *silent*. Warn at most once every
// 30s so a misconfigured endpoint is visible in the console without spamming it.
let lastWarnAt = 0
function warnDropped(what: string, error: unknown): void {
	const now = Date.now()
	if (now - lastWarnAt < 30_000) return
	lastWarnAt = now
	console.warn(`[maple] session replay ${what} failed (dropping; will retry on next chunk):`, error)
}

/** gzip a byte buffer using the native CompressionStream (no library). */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new CompressionStream("gzip")
	const writer = stream.writable.getWriter()
	void writer.write(bytes as BufferSource)
	void writer.close()
	const buffer = await new Response(stream.readable).arrayBuffer()
	return new Uint8Array(buffer)
}

/** POST session metadata (NDJSON, single row). `keepalive` for the final unload write. */
export async function postSessionMeta(
	config: ResolvedConfig,
	row: Record<string, unknown>,
	keepalive = false,
): Promise<void> {
	const body = `${JSON.stringify(row)}\n`
	await fetch(`${config.endpoint}/v1/sessionReplays/meta`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.ingestKey}`,
			"content-type": "application/x-ndjson",
		},
		body,
		keepalive,
	}).catch((error) => {
		// Replay is best-effort; never throw into the host app.
		warnDropped("metadata POST", error)
	})
}

export interface ChunkMeta {
	readonly sessionId: string
	readonly chunkSeq: number
	readonly isCheckpoint: boolean
	readonly eventCount: number
	readonly durationMs: number
}

/** PUT a gzipped rrweb event chunk. */
export async function postSessionBlob(
	config: ResolvedConfig,
	meta: ChunkMeta,
	gzipped: Uint8Array,
	keepalive = false,
): Promise<void> {
	await fetch(`${config.endpoint}/v1/sessionReplays/blob`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.ingestKey}`,
			"content-type": "application/octet-stream",
			"x-maple-session-id": meta.sessionId,
			"x-maple-chunk-seq": String(meta.chunkSeq),
			"x-maple-is-checkpoint": meta.isCheckpoint ? "1" : "0",
			"x-maple-event-count": String(meta.eventCount),
			"x-maple-duration-ms": String(meta.durationMs),
		},
		body: gzipped as unknown as BodyInit,
		keepalive,
	}).catch((error) => {
		// Best-effort.
		warnDropped("blob PUT", error)
	})
}
