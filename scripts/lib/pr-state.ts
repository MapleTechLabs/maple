/**
 * The preview-state gate shared by the preview orphan sweeps (cleanup-preview-orphans.yml).
 *
 * Auth: GITHUB_REPOSITORY + GITHUB_TOKEN/GH_TOKEN.
 */

/** `live`: open and labelled `preview`. `retired`: closed, or open without the label. */
export type PreviewState = "live" | "retired" | "unknown"

export const PREVIEW_LABEL = "preview"

export const hasPrStateCredentials = (): boolean =>
	Boolean(
		process.env.GITHUB_REPOSITORY?.trim() && (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim(),
	)

/** An open PR that lost its label is retired too: a cancelled teardown leaves its stage up. */
export const previewStateOf = (pull: {
	state?: string
	labels?: ReadonlyArray<{ name?: string }>
}): PreviewState => {
	if (pull.state === "closed") return "retired"
	if (pull.state !== "open") return "unknown"
	return pull.labels?.some((label) => label.name === PREVIEW_LABEL) ? "live" : "retired"
}

/**
 * Preview state via the GitHub REST API. Returns "unknown" when the API call
 * fails; callers must treat "unknown" as "don't delete", never as "retired".
 */
export const fetchPreviewState = async (prNumber: string): Promise<PreviewState> => {
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
		return previewStateOf(
			(await response.json()) as { state?: string; labels?: ReadonlyArray<{ name?: string }> },
		)
	} catch (error) {
		console.log(
			`⚠ Could not look up PR #${prNumber} state (${error instanceof Error ? error.message : String(error)})`,
		)
		return "unknown"
	}
}
