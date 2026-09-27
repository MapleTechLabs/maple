/**
 * Changelog vocabulary shared by the content schema and the pages. Kept free of
 * `astro:content` so `content.config.ts` can import it.
 */

export const CHANGELOG_CATEGORIES = [
	"traces",
	"logs",
	"errors",
	"replays",
	"dashboards",
	"alerts",
	"services",
	"agent-sessions",
	"ai",
	"integrations",
	"api",
	"billing",
	"platform",
	"sdk",
] as const

export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number]

export const CATEGORY_LABELS = {
	traces: "Traces",
	logs: "Logs",
	errors: "Errors",
	replays: "Replays",
	dashboards: "Dashboards",
	alerts: "Alerts",
	services: "Services",
	"agent-sessions": "Agent Sessions",
	ai: "AI",
	integrations: "Integrations",
	api: "API",
	billing: "Billing",
	platform: "Platform",
	sdk: "SDK",
} satisfies Record<ChangelogCategory, string>

export const CONTRIBUTOR_IDS = ["makisuo", "jeremyfunk"] as const

export type ContributorId = (typeof CONTRIBUTOR_IDS)[number]

export interface Contributor {
	name: string
	github: string
	/** Served from /public, so the page makes no third-party avatar requests. */
	avatar: string
}

export const CONTRIBUTORS = {
	makisuo: { name: "Makisuo", github: "Makisuo", avatar: "/changelog/contributors/makisuo.png" },
	jeremyfunk: {
		name: "JeremyFunk",
		github: "JeremyFunk",
		avatar: "/changelog/contributors/jeremyfunk.png",
	},
} satisfies Record<ContributorId, Contributor>
