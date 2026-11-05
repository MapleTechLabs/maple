import { String as Str } from "effect"
const normalize = (configured: string | undefined, fallback: string) => {
	const trimmed = configured === undefined ? undefined : Str.trim(configured)
	return trimmed && trimmed.length > 0 ? Str.replace(/\/$/, "")(trimmed) : fallback
}

/** The endpoint users send their telemetry to (setup snippets, connect flows). */
export const ingestUrl = normalize(import.meta.env.VITE_INGEST_URL, "https://ingest.maple.dev")

/** Where the app's own telemetry goes. Differs from {@link ingestUrl} on PR previews only. */
export const selfIngestUrl = normalize(import.meta.env.VITE_MAPLE_SELF_INGEST_URL, ingestUrl)
