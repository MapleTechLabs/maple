/**
 * The PR-state gate shared by the preview orphan sweeps (cleanup-preview-orphans.yml).
 *
 * Auth: GITHUB_REPOSITORY + GITHUB_TOKEN/GH_TOKEN.
 */

export type PrState = "open" | "closed" | "unknown"

export const hasPrStateCredentials = (): boolean =>
	Boolean(
		process.env.GITHUB_REPOSITORY?.trim() && (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim(),
	)

/**
 * PR state via the GitHub REST API. Returns "unknown" when the API call
 * fails; callers must treat "unknown" as "don't delete", never as "closed".
 */
export const fetchPrState = async (prNumber: string): Promise<PrState> => {
	const repo = process.env.GITHUB_REPOSITORY?.trim()
	const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim()
	if (!repo || !token) return "unknown"
	try {
		const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		})
		if (!response.ok) {
			console.log(`⚠ Could not look up PR #${prNumber} state (HTTP ${response.status})`)
			return "unknown"
		}
		const parsed = (await response.json()) as { state?: string }
		return parsed.state === "open" ? "open" : parsed.state === "closed" ? "closed" : "unknown"
	} catch (error) {
		console.log(
			`⚠ Could not look up PR #${prNumber} state (${error instanceof Error ? error.message : String(error)})`,
		)
		return "unknown"
	}
}
