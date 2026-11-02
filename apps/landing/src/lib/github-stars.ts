const REPO = "MapleTechLabs/maple"

let cached: Promise<number | null> | undefined

/**
 * Fetches the repo's stargazer count once per build, memoized.
 *
 * Nav/Footer render on every page and DocsLayout on every docs page, so the
 * module-level cache is what keeps a full static build to a single API call —
 * without it a large build could blow GitHub's 60/hr unauthenticated limit.
 *
 * Any failure (non-OK response, network error, unexpected shape) resolves to
 * `null` so the build never breaks and callers simply omit the count.
 */
export function getGitHubStars(): Promise<number | null> {
	if (!cached) {
		cached = fetchStars()
	}
	return cached
}

async function fetchStars(): Promise<number | null> {
	try {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
		} satisfies Record<string, string>
		const token = import.meta.env.GITHUB_TOKEN
		if (token) {
			headers.Authorization = `Bearer ${token}`
		}

		const res = await fetch(`https://api.github.com/repos/${REPO}`, { headers })
		if (!res.ok) return null

		const data = (await res.json()) as { stargazers_count?: unknown }
		return typeof data.stargazers_count === "number" ? data.stargazers_count : null
	} catch {
		return null
	}
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/** Formats a star count compactly, e.g. 1234 → "1.2K". */
export function formatStars(count: number): string {
	return compact.format(count)
}

export const GITHUB_REPO_URL = "https://github.com/MapleTechLabs/maple"

/** GitHub's "octocat" mark (24x24, `currentColor`), shared by the star button and the nav sheet. */
export const OCTOCAT_PATH =
	"M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"
