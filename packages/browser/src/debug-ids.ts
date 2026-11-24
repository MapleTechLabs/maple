// Debug ids that `maple sourcemaps inject` (or Sentry's tooling) registers per script, keyed by
// a stack captured inside that script. The backend picks the source map by id, not by URL.
import { frameUrls } from "@maple/sdk-core"

let registered = -1
let byUrl = new Map<string, string>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

/** Script URL -> debug id, rebuilt when the registered count changes (chunks load lazily). */
function debugIdsByUrl(): Map<string, string> {
	const owner: Record<string, unknown> = globalThis
	// Maple's registry last, so it wins over Sentry's for the same script.
	const registries = [owner._sentryDebugIds, owner._mapleDebugIds].filter(isRecord)
	// Counting keys allocates no entry pairs, so an unchanged registry costs little per exception.
	const count = registries.reduce((total, registry) => total + Object.keys(registry).length, 0)
	if (count !== registered) {
		registered = count
		byUrl = new Map()
		for (const [stack, id] of registries.flatMap((registry) => Object.entries(registry))) {
			const url = frameUrls(stack)[0]
			if (url !== undefined && typeof id === "string") byUrl.set(url, id)
		}
	}
	return byUrl
}

/** `maple.exception.debug_ids` for `stack`: `{url: debugId}` JSON for each registered script in it. */
export function debugIdsOf(stack: string): string | undefined {
	const known = debugIdsByUrl()
	const urls = known.size > 0 ? frameUrls(stack).filter((url) => known.has(url)) : []
	return urls.length > 0
		? JSON.stringify(Object.fromEntries(urls.map((url) => [url, known.get(url)])))
		: undefined
}

/** Test seam. */
export function resetDebugIdsForTests(): void {
	registered = -1
	byUrl = new Map()
}
