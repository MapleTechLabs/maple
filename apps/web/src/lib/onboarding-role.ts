/**
 * The role step. Roles are split by what the person is looking at day to day —
 * backend vs. frontend, operating vs. building, managing vs. founding — because
 * that is what changes the default SDK snippet and the first pages we point at.
 * "Something else" takes a free-text answer.
 */
export const ONBOARDING_ROLE_IDS = [
	"backend",
	"frontend",
	"devops_sre",
	"eng_leader",
	"founder",
	"other",
] as const

export type OnboardingRole = (typeof ONBOARDING_ROLE_IDS)[number]

type RoleCopy = {
	label: string
	/** One line under the label: the surface area, not a persona description. */
	title: string
	/** Shown once the role is picked. */
	greeting: string
}

export const ONBOARDING_ROLES = {
	backend: {
		label: "Backend engineer",
		title: "Services, APIs, queues, databases.",
		greeting: "From your code to the whole story.",
	},
	frontend: {
		label: "Frontend or mobile engineer",
		title: "Web and mobile apps, and the sessions behind them.",
		greeting: "Every click, with the request it made.",
	},
	devops_sre: {
		label: "DevOps / SRE / Platform",
		title: "Clusters, hosts, and the pager.",
		greeting: "For the quiet shifts. And the other ones.",
	},
	eng_leader: {
		label: "Engineering manager",
		title: "Incidents, reliability, and what they cost.",
		greeting: "A shared view for the people building it.",
	},
	founder: {
		label: "Founder / CTO",
		title: "The whole stack, with a small team.",
		greeting: "You wear enough hats. Let's make this part easier.",
	},
	other: {
		label: "Something else",
		title: "Tell us in a few words.",
		greeting: "We'll keep the defaults general.",
	},
} satisfies Record<OnboardingRole, RoleCopy>

/** Free-text roles are capped so the stored answer stays a label, not a paragraph. */
export const ROLE_DETAIL_MAX_LENGTH = 80
