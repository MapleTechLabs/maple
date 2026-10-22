import type { V2Source } from "@maple/domain/http/v2"
import type { PullSourcePlatform } from "@maple/domain/primitives"
import { integrationPlatformOf } from "./shared"

// What deleting an integration source disconnects. Google Cloud keeps its own removal dialog.

const DISCONNECTS = {
	prometheus: "Maple stops scraping its targets and removes them",
	cloudflare: "Maple revokes its read-only Cloudflare token",
	gcp: "Maple stops accepting its logs and metrics",
	railway: "Maple deletes its Railway API token",
	planetscale: "Maple drops its PlanetScale access and the metrics scrape",
	github: "Maple forgets this installation's repositories and commits",
	supabase: "Maple removes its log drains and revokes its Supabase access",
} as const satisfies Record<PullSourcePlatform, string>

/** The lines the delete dialog lists for an integration source, most specific first. */
export const deleteConsequences = (source: V2Source): ReadonlyArray<string> => {
	const platform = integrationPlatformOf(source)
	if (platform === null) return []
	return [
		DISCONNECTS[platform],
		"Nothing new is collected or billed",
		"Data already stored stays until retention ends",
		...(platform === "github" ? ["Uninstall the GitHub App on GitHub to revoke its access there"] : []),
	]
}

/** Google Cloud's removal has a cleanup step, so its Delete opens the integration's own dialog. */
export const hasOwnRemoval = (source: V2Source): boolean => source.platform === "gcp"
