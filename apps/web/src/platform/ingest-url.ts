import { envUrl } from "./env-url"

/** The endpoint users send their telemetry to (setup snippets, connect flows). */
export const ingestUrl = envUrl(import.meta.env.VITE_INGEST_URL) ?? "https://ingest.maple.dev"

/** Where the app's own telemetry goes. Differs from {@link ingestUrl} on PR previews only. */
export const selfIngestUrl = envUrl(import.meta.env.VITE_MAPLE_SELF_INGEST_URL) ?? ingestUrl
