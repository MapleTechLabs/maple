import {
	PrReviewCategory,
	type PrReviewFeedbackScope,
	PrReviewRepositoryConfig,
	type PrReviewSeverity,
} from "@maple/domain/http"
import { Schema } from "effect"

// The review rules form state and its conversions.

export const INSTRUCTIONS_MAX = 4_000
const IGNORE_PATH_MAX = 200
export const DAILY_LIMIT_MAX = 500
export const AUTOMATIC_LIMIT_MAX = 50
export const ALL_CATEGORIES = PrReviewCategory.literals
export const INHERIT = "inherit"

export const SEVERITY_LABELS = {
	critical: "Critical only",
	warn: "Warning and critical",
	info: "Every issue",
} satisfies Record<PrReviewSeverity, string>
export const FEEDBACK_LABELS = {
	organization: "Whole organization",
	repository: "This repository",
	off: "Off",
} satisfies Record<PrReviewFeedbackScope, string>

/** What a review uses when neither the organization nor the repository says otherwise. */
export const BUILT_IN = {
	minInlineSeverity: "warn",
	reviewDrafts: false,
	reviewExternalContributors: false,
	feedbackScope: "organization",
	blockOnContractBreaks: false,
	postMergeCheck: true,
} as const

export const Mode = Schema.Literals(["organization", "repository"])
export type Mode = typeof Mode.Type

/** `"inherit"`, `"on"`/`"off"`, a severity or a feedback scope: what each select holds. */
export const FormState = Schema.Struct({
	instructions: Schema.String,
	ignorePaths: Schema.String,
	/** Null inherits the organization's lenses. */
	categories: Schema.NullOr(Schema.Array(PrReviewCategory)),
	minInlineSeverity: Schema.String,
	reviewDrafts: Schema.String,
	reviewExternalContributors: Schema.String,
	dailyLimit: Schema.String,
	automaticReviewLimit: Schema.String,
	feedbackScope: Schema.String,
	blockOnContractBreaks: Schema.String,
	postMergeCheck: Schema.String,
})
export type FormState = typeof FormState.Type

const toggleFromConfig = (value: boolean | undefined, inherits: boolean, builtIn: boolean): string =>
	value === undefined ? (inherits ? INHERIT : builtIn ? "on" : "off") : value ? "on" : "off"

const toggleToConfig = (value: string, org: boolean, builtIn: boolean): boolean | undefined =>
	value === INHERIT || (org && (value === "on") === builtIn) ? undefined : value === "on"

export const stateFromConfig = (mode: Mode, config: PrReviewRepositoryConfig): FormState => {
	const inherits = mode === "repository"
	return {
		instructions: config.instructions ?? "",
		ignorePaths: (config.ignorePaths ?? []).join("\n"),
		categories: config.categories ?? (inherits ? null : ALL_CATEGORIES),
		minInlineSeverity: config.minInlineSeverity ?? (inherits ? INHERIT : BUILT_IN.minInlineSeverity),
		reviewDrafts:
			config.reviewDrafts === undefined
				? inherits
					? INHERIT
					: "off"
				: config.reviewDrafts
					? "on"
					: "off",
		reviewExternalContributors: toggleFromConfig(
			config.reviewExternalContributors,
			inherits,
			BUILT_IN.reviewExternalContributors,
		),
		dailyLimit: config.dailyLimit === undefined ? "" : String(config.dailyLimit),
		automaticReviewLimit:
			config.automaticReviewLimit === undefined ? "" : String(config.automaticReviewLimit),
		feedbackScope: config.feedbackScope ?? (inherits ? INHERIT : BUILT_IN.feedbackScope),
		blockOnContractBreaks: toggleFromConfig(
			config.blockOnContractBreaks,
			inherits,
			BUILT_IN.blockOnContractBreaks,
		),
		postMergeCheck: toggleFromConfig(config.postMergeCheck, inherits, BUILT_IN.postMergeCheck),
	}
}

const sameCategories = (a: FormState["categories"], b: FormState["categories"]) =>
	a === null || b === null ? a === b : a.length === b.length && a.every((category) => b.includes(category))

export const sameState = (a: FormState, b: FormState) =>
	a.instructions === b.instructions &&
	a.ignorePaths === b.ignorePaths &&
	a.minInlineSeverity === b.minInlineSeverity &&
	a.reviewDrafts === b.reviewDrafts &&
	a.reviewExternalContributors === b.reviewExternalContributors &&
	a.dailyLimit === b.dailyLimit &&
	a.automaticReviewLimit === b.automaticReviewLimit &&
	a.feedbackScope === b.feedbackScope &&
	a.blockOnContractBreaks === b.blockOnContractBreaks &&
	a.postMergeCheck === b.postMergeCheck &&
	sameCategories(a.categories, b.categories)

const parseIgnorePaths = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)

const checkLimit = (text: string, max: number, label: string): string | null => {
	const trimmed = text.trim()
	if (trimmed === "") return null
	const value = Number(trimmed)
	return Number.isInteger(value) && value >= 1 && value <= max
		? null
		: `${label} must be a whole number from 1 to ${max}.`
}

/** The first problem that would make the server reject the form, if any. */
export const validate = (state: FormState): string | null => {
	if (state.instructions.length > INSTRUCTIONS_MAX)
		return `Instructions are limited to ${INSTRUCTIONS_MAX} characters.`
	if (parseIgnorePaths(state.ignorePaths).some((path) => path.length > IGNORE_PATH_MAX))
		return `Each ignored path is limited to ${IGNORE_PATH_MAX} characters.`
	if (parseIgnorePaths(state.ignorePaths).length > 50) return "At most 50 ignored paths."
	if (state.categories !== null && state.categories.length === 0) return "Pick at least one lens."
	return (
		checkLimit(state.dailyLimit, DAILY_LIMIT_MAX, "Daily limit") ??
		checkLimit(state.automaticReviewLimit, AUTOMATIC_LIMIT_MAX, "Reviews per pull request")
	)
}

const SEVERITIES = ["critical", "warn", "info"] as const
const FEEDBACK_SCOPES = ["organization", "repository", "off"] as const

/** Inherited and built-in values are omitted, so later default changes still reach the config. */
export const configFromState = (mode: Mode, state: FormState): PrReviewRepositoryConfig => {
	const instructions = state.instructions.trim()
	const ignorePaths = parseIgnorePaths(state.ignorePaths)
	const limit = state.dailyLimit.trim()
	const perPullRequest = state.automaticReviewLimit.trim()
	const org = mode === "organization"
	const categories =
		state.categories === null || (org && state.categories.length === ALL_CATEGORIES.length)
			? undefined
			: ALL_CATEGORIES.filter((category) => state.categories?.includes(category))
	const severity =
		state.minInlineSeverity === INHERIT || (org && state.minInlineSeverity === BUILT_IN.minInlineSeverity)
			? undefined
			: SEVERITIES.find((value) => value === state.minInlineSeverity)
	const drafts =
		state.reviewDrafts === INHERIT || (org && state.reviewDrafts === "off")
			? undefined
			: state.reviewDrafts === "on"
	const feedback =
		state.feedbackScope === INHERIT || (org && state.feedbackScope === BUILT_IN.feedbackScope)
			? undefined
			: FEEDBACK_SCOPES.find((value) => value === state.feedbackScope)
	const external = toggleToConfig(
		state.reviewExternalContributors,
		org,
		BUILT_IN.reviewExternalContributors,
	)
	const block = toggleToConfig(state.blockOnContractBreaks, org, BUILT_IN.blockOnContractBreaks)
	const postMerge = toggleToConfig(state.postMergeCheck, org, BUILT_IN.postMergeCheck)
	return new PrReviewRepositoryConfig({
		...(instructions === "" ? undefined : { instructions }),
		...(ignorePaths.length === 0 ? undefined : { ignorePaths }),
		...(categories === undefined ? undefined : { categories }),
		...(severity === undefined ? undefined : { minInlineSeverity: severity }),
		...(drafts === undefined ? undefined : { reviewDrafts: drafts }),
		...(external === undefined ? undefined : { reviewExternalContributors: external }),
		...(limit === "" ? undefined : { dailyLimit: Number(limit) }),
		...(perPullRequest === "" ? undefined : { automaticReviewLimit: Number(perPullRequest) }),
		...(feedback === undefined ? undefined : { feedbackScope: feedback }),
		...(block === undefined ? undefined : { blockOnContractBreaks: block }),
		...(postMerge === undefined ? undefined : { postMergeCheck: postMerge }),
	})
}
