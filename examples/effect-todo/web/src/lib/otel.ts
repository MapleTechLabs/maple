/**
 * Browser tracing → Maple local mode. Mirrors apps/web's otel-layer.ts.
 *
 * Every HTTP request the app makes is wrapped in an `http.client` span and
 * carries a W3C `traceparent` header, so the backend continues the SAME trace.
 * These browser spans export straight to the local-mode OTLP ingest, which is
 * what makes `todo-web` show up as its own service (and draws the
 * `todo-web → todo-api` edge on the service map).
 */
import { Maple } from "@maple-dev/effect-sdk/client"

export const todoOtelLayer = Maple.layer({
	serviceName: "todo-web",
	serviceNamespace: "examples",
	environment: "development",
	endpoint: import.meta.env.VITE_MAPLE_ENDPOINT ?? "http://127.0.0.1:4318",
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY,
	tracerExportInterval: "2 seconds",
	loggerExportInterval: "2 seconds",
})
