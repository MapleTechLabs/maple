import type { CloudPlatformInfo } from "./types"
import { cloudflareAdapter } from "./cloudflare"

export type {
	CloudPlatformAdapter,
	CloudPlatformField,
	CloudPlatformInfo,
	CloudPlatformOutcome,
} from "./types"
export { outcomeBadgeStyle } from "./types"

// Registered platform adapters, checked in order. The trace views consume only
// the normalized `CloudPlatformInfo`, so supporting a new provider is purely
// additive — no component changes.
//
// To add a provider (e.g. Vercel Functions):
//   1. create `./vercel.ts` exporting a `CloudPlatformAdapter` whose `detect`
//      recognizes its attributes (e.g. `cloud.platform === "vercel"`) and maps
//      them onto `CloudPlatformInfo` — `vercel.region` → `edge`, a deployment
//      id → a copyable field, etc.
//   2. import it here and add it to `ADAPTERS`.
// Order matters only if two adapters could match the same span; keep the most
// specific first.
const ADAPTERS: ReadonlyArray<{ detect: (a: Record<string, string>) => CloudPlatformInfo | null }> =
	[cloudflareAdapter]

/** First adapter that recognizes these span attributes, normalized; else null. */
export function getCloudPlatform(attrs: Record<string, string>): CloudPlatformInfo | null {
	for (const adapter of ADAPTERS) {
		const info = adapter.detect(attrs)
		if (info) return info
	}
	return null
}
