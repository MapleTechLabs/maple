import type { V2Source } from "@maple/domain/http/v2"
import type { PullSourcePlatform } from "@maple/domain/primitives"
import { integrationPlatformOf } from "./shared"

// What deleting an integration source disconnects. Google Cloud and AWS keep their own removal dialog.

const DISCONNECTS = {
	prometheus: "Maple stops scraping its targets and removes them",
	cloudflare: "Maple revokes its read-only Cloudflare token",
	gcp: "Maple stops accepting its logs and metrics",
	aws: "Maple stops assuming its role in the account",
	railway: "Maple deletes its Railway API token",
	planetscale: "Maple drops its PlanetScale access and the metrics scrape",
	github: "Maple deletes this installation's repositories, branches and commits",
	supabase: "Maple removes its log drains and revokes its Supabase access",
} as const satisfies Record<PullSourcePlatform, string>

/** The lines the delete dialog lists for an integration source, most specific first. */
export const deleteConsequences = (source: V2Source): ReadonlyArray<string> => {
	const platform = integrationPlatformOf(source)
	if (platform === null) return []
	return [
		DISCONNECTS[platform],
		"Nothing new is collected or billed",
		...(keepsStoredData(source)
			? ["Data already stored stays until retention ends"]
			: ["Uninstall the GitHub App on GitHub to revoke its access there"]),
	]
}

/** Deleting keeps what the source already stored, except GitHub's repositories and commits, which go with it. */
export const keepsStoredData = (source: V2Source): boolean => source.platform !== "github"

/** Google Cloud's and AWS's removal have a cleanup step, so their Delete opens the integration's own dialog. */
export const hasOwnRemoval = (source: V2Source): boolean =>
	source.platform === "gcp" || source.platform === "aws"
