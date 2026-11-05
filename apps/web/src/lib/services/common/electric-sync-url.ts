import { Option, String as Str } from "effect"

const configuredElectricSyncUrl = Option.map(
	Option.fromNullishOr(import.meta.env.VITE_ELECTRIC_SYNC_URL),
	Str.trim,
).pipe(Option.getOrUndefined)

/**
 * Origin of the standalone ElectricSQL shape-proxy worker (`apps/electric-sync`).
 * Set at build time via `VITE_ELECTRIC_SYNC_URL`; defaults to the local worker's
 * dev port (see `apps/electric-sync/package.json` `dev:app`).
 */
export const electricSyncBaseUrl =
	configuredElectricSyncUrl && configuredElectricSyncUrl.length > 0
		? Str.replace(/\/$/, "")(configuredElectricSyncUrl)
		: "http://127.0.0.1:3476"

/** Off on a deploy with no Electric upstream (`VITE_ELECTRIC_SYNC_DISABLED=1`, `preview:web`). */
export const electricSyncEnabled = import.meta.env.VITE_ELECTRIC_SYNC_DISABLED !== "1"
