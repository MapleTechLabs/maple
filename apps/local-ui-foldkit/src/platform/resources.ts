import { FetchHttpClient, type HttpClient } from "effect/http"

/** The runtime's `resources`: the one HTTP client every `/local/*` Command runs on. */
export const ResourcesLive = FetchHttpClient.layer
export type Resources = HttpClient.HttpClient
