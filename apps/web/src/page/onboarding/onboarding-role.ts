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
