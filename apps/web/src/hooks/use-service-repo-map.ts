import { useMemo } from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

export interface ServiceRepo {
	readonly repoOwner: string
	readonly repoName: string
}

/**
 * Resolves the org's service.name → GitHub repo mappings into a Map.
 * Atom-cached, so multiple pages share a single fetch.
 */
export function useServiceRepoMap(): Map<string, ServiceRepo> {
	const result = useAtomValue(
		MapleApiAtomClient.query("integrations", "githubServiceRepos", {
			reactivityKeys: ["githubServiceRepoMappings"],
		}),
	)

	return useMemo(() => {
		const mappings = Result.builder(result)
			.onSuccess((r) => r.mappings)
			.orElse(() => [])
		const map = new Map<string, ServiceRepo>()
		for (const m of mappings) {
			map.set(m.serviceName, { repoOwner: m.repoOwner, repoName: m.repoName })
		}
		return map
	}, [result])
}

export function commitUrl(repo: ServiceRepo, commitSha: string): string {
	return `https://github.com/${repo.repoOwner}/${repo.repoName}/commit/${commitSha}`
}
