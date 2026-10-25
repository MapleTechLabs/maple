/**
 * The preview-state gate shared by the preview orphan sweeps (cleanup-preview-orphans.yml).
 *
 * Auth: GITHUB_REPOSITORY + GITHUB_TOKEN/GH_TOKEN.
 */

/** `live`: open with a preview label. `retired`: closed, or open without one. */
export type PreviewState = "live" | "retired" | "unknown"

/** `preview` is the full stack, `preview:web` the Workers alone (deploy-pr-preview.yml). */
export const PREVIEW_LABELS: ReadonlySet<string> = new Set(["preview", "preview:web"])

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
	return pull.labels?.some((label) => label.name !== undefined && PREVIEW_LABELS.has(label.name))
		? "live"
		: "retired"
}

/**
 * Whether a preview deploy run for this PR is queued or running, so a sweep never destroys a
 * stage that a restored label is redeploying. "unknown" when the API call fails.
 */
export const hasActivePreviewRun = async (prNumber: string): Promise<boolean | "unknown"> => {
	const repo = process.env.GITHUB_REPOSITORY?.trim()
	const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim()
	if (!repo || !token) return "unknown"
	try {
		for (const status of ["queued", "in_progress"]) {
			const response = await fetch(
				`https://api.github.com/repos/${repo}/actions/workflows/deploy-pr-preview.yml/runs?status=${status}&per_page=100`,
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
				},
			)
			if (!response.ok) {
				console.log(`⚠ Could not list ${status} preview runs (HTTP ${response.status})`)
				return "unknown"
			}
			const { workflow_runs: runs = [] } = (await response.json()) as {
				workflow_runs?: ReadonlyArray<{ pull_requests?: ReadonlyArray<{ number?: number }> }>
			}
			if (runs.some((run) => run.pull_requests?.some((pull) => String(pull.number) === prNumber))) {
				return true
			}
		}
		return false
	} catch (error) {
		console.log(
			`⚠ Could not list preview runs (${error instanceof Error ? error.message : String(error)})`,
		)
		return "unknown"
	}
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
