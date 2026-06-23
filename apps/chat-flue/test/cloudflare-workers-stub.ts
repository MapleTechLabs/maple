// Test stub for the workerd-only `cloudflare:workers` virtual module. Exposes an
// empty env so importing `app.ts` under node leaves telemetry disabled (no-op).
export const env = {}
