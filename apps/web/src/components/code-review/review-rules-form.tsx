import { useState } from "react"
import { Schema } from "effect"
import {
	PrReviewCategory,
	PrReviewFeedbackScope,
	PrReviewRepositoryConfig,
	PrReviewSeverity,
} from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Switch } from "@maple/ui/components/ui/switch"
import { Textarea } from "@maple/ui/components/ui/textarea"

import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"

import { CATEGORY_LABELS } from "./code-review-format"

const INSTRUCTIONS_MAX = 4_000
const IGNORE_PATH_MAX = 200
const DAILY_LIMIT_MAX = 500
const AUTOMATIC_LIMIT_MAX = 50
const ALL_CATEGORIES = PrReviewCategory.literals
const INHERIT = "inherit"

const SEVERITY_LABELS = {
	critical: "Critical only",
	warn: "Warning and critical",
	info: "Every issue",
} satisfies Record<PrReviewSeverity, string>
const FEEDBACK_LABELS = {
	organization: "Whole organization",
	repository: "This repository",
	off: "Off",
} satisfies Record<PrReviewFeedbackScope, string>
const isSeverity = Schema.is(PrReviewSeverity)
const isFeedbackScope = Schema.is(PrReviewFeedbackScope)

/** What a review uses when neither the organization nor the repository says otherwise. */
const BUILT_IN = {
	minInlineSeverity: "warn",
	reviewDrafts: false,
	feedbackScope: "organization",
} as const

/**
 * `organization` edits the rules every repository starts from; an absent field there is the
 * built-in default. `repository` edits one repository's overrides; an absent field there inherits
 * the organization's value, and instructions and ignored paths add to the organization's.
 */
export type ReviewRulesMode = "organization" | "repository"

type Inheritable<A> = A | typeof INHERIT

interface FormState {
	readonly instructions: string
	readonly ignorePaths: string
	/** Null inherits the organization's lenses. */
	readonly categories: ReadonlyArray<PrReviewCategory> | null
	readonly minInlineSeverity: Inheritable<PrReviewSeverity>
	readonly reviewDrafts: Inheritable<"on" | "off">
	readonly dailyLimit: string
	readonly automaticReviewLimit: string
	readonly feedbackScope: Inheritable<PrReviewFeedbackScope>
}

const stateFromConfig = (mode: ReviewRulesMode, config: PrReviewRepositoryConfig): FormState => {
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
		dailyLimit: config.dailyLimit === undefined ? "" : String(config.dailyLimit),
		automaticReviewLimit:
			config.automaticReviewLimit === undefined ? "" : String(config.automaticReviewLimit),
		feedbackScope: config.feedbackScope ?? (inherits ? INHERIT : BUILT_IN.feedbackScope),
	}
}

const sameCategories = (a: FormState["categories"], b: FormState["categories"]) =>
	a === null || b === null ? a === b : a.length === b.length && a.every((category) => b.includes(category))

const sameState = (a: FormState, b: FormState) =>
	a.instructions === b.instructions &&
	a.ignorePaths === b.ignorePaths &&
	a.minInlineSeverity === b.minInlineSeverity &&
	a.reviewDrafts === b.reviewDrafts &&
	a.dailyLimit === b.dailyLimit &&
	a.automaticReviewLimit === b.automaticReviewLimit &&
	a.feedbackScope === b.feedbackScope &&
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
const validate = (state: FormState): string | null => {
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

/**
 * Inherited and built-in values are omitted rather than stored, so a later change to the
 * organization's rules (or to a built-in default) still reaches this config.
 */
const configFromState = (mode: ReviewRulesMode, state: FormState) => {
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
			: state.minInlineSeverity
	const drafts =
		state.reviewDrafts === INHERIT || (org && state.reviewDrafts === "off")
			? undefined
			: state.reviewDrafts === "on"
	const feedback =
		state.feedbackScope === INHERIT || (org && state.feedbackScope === BUILT_IN.feedbackScope)
			? undefined
			: state.feedbackScope
	return new PrReviewRepositoryConfig({
		...(instructions === "" ? undefined : { instructions }),
		...(ignorePaths.length === 0 ? undefined : { ignorePaths }),
		...(categories === undefined ? undefined : { categories }),
		...(severity === undefined ? undefined : { minInlineSeverity: severity }),
		...(drafts === undefined ? undefined : { reviewDrafts: drafts }),
		...(limit === "" ? undefined : { dailyLimit: Number(limit) }),
		...(perPullRequest === "" ? undefined : { automaticReviewLimit: Number(perPullRequest) }),
		...(feedback === undefined ? undefined : { feedbackScope: feedback }),
	})
}

export function ReviewRulesForm({
	mode,
	config,
	inherited,
	onSave,
	idPrefix,
}: {
	mode: ReviewRulesMode
	config: PrReviewRepositoryConfig
	/** The organization's rules, named in a repository form's "Organization default" options. */
	inherited?: PrReviewRepositoryConfig
	/** Resolves with an error message, or null once saved. */
	onSave: (config: PrReviewRepositoryConfig) => Promise<string | null>
	idPrefix: string
}) {
	const isAdmin = useIsOrgAdmin()
	const [state, setState] = useState(() => stateFromConfig(mode, config))
	const [saved, setSaved] = useState(() => stateFromConfig(mode, config))
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	// What was last sent, so a refetch landing after the save keeps any edit made since.
	const [submitted, setSubmitted] = useState<FormState | null>(null)
	// A refetched config replaces the form unless it was edited after Save; adjusted during render.
	const [seenConfig, setSeenConfig] = useState(config)
	if (seenConfig !== config) {
		setSeenConfig(config)
		setSaved(stateFromConfig(mode, config))
		if (submitted === null || sameState(state, submitted)) setState(stateFromConfig(mode, config))
		setSubmitted(null)
	}

	const problem = validate(state)
	const dirty = !sameState(state, saved)
	const repository = mode === "repository"
	const parent = inherited ?? new PrReviewRepositoryConfig({})

	const update = (patch: Partial<FormState>) => {
		setState((prev) => ({ ...prev, ...patch }))
		setError(null)
	}

	async function handleSave() {
		setSaving(true)
		setSubmitted(state)
		setError(null)
		const failure = await onSave(configFromState(mode, state))
		setSaving(false)
		if (failure !== null) setError(failure)
	}

	const inheritedSeverity = SEVERITY_LABELS[parent.minInlineSeverity ?? BUILT_IN.minInlineSeverity]
	const inheritedFeedback = FEEDBACK_LABELS[parent.feedbackScope ?? BUILT_IN.feedbackScope]
	const inheritedDrafts = (parent.reviewDrafts ?? BUILT_IN.reviewDrafts) ? "Review drafts" : "Skip drafts"
	const limitPlaceholder = (value: number | undefined) =>
		repository ? `Organization default (${value ?? "no limit"})` : "No limit"

	const severityItems = {
		...(repository ? { [INHERIT]: `Organization default (${inheritedSeverity})` } : undefined),
		...SEVERITY_LABELS,
	}
	const feedbackItems = {
		...(repository ? { [INHERIT]: `Organization default (${inheritedFeedback})` } : undefined),
		...FEEDBACK_LABELS,
	}
	const draftItems = {
		[INHERIT]: `Organization default (${inheritedDrafts})`,
		on: "Review drafts",
		off: "Skip drafts",
	}
	const parentCategories = parent.categories ?? ALL_CATEGORIES

	// Frozen while saving: a refetch after the save would replace any edit made in the meantime.
	return (
		<fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-instructions`}>
					{repository ? "Additional instructions" : "Instructions"}
				</Label>
				<Textarea
					id={`${idPrefix}-instructions`}
					size="sm"
					value={state.instructions}
					maxLength={INSTRUCTIONS_MAX}
					placeholder={
						repository
							? "Rules for this repository, read after the organization's."
							: 'Rules every review applies on top of its defaults, e.g. "Flag any new endpoint without an auth check."'
					}
					controlClassName="min-h-24 max-h-64"
					onChange={(event) => update({ instructions: event.target.value })}
				/>
				<p className="text-xs text-muted-foreground">
					Read alongside each repository&apos;s own CLAUDE.md, AGENTS.md and .maple/review.md.{" "}
					{state.instructions.length}/{INSTRUCTIONS_MAX}
				</p>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-ignore`}>
					{repository ? "Additional ignored paths" : "Ignored paths"}
				</Label>
				<Textarea
					id={`${idPrefix}-ignore`}
					size="sm"
					value={state.ignorePaths}
					placeholder={"generated/\n*.pb.go\napps/**/routeTree.gen.ts"}
					controlClassName="max-h-40 font-mono"
					onChange={(event) => update({ ignorePaths: event.target.value })}
				/>
				<p className="text-xs text-muted-foreground">
					One per line. The review never reads files that match.
					{repository && parent.ignorePaths && parent.ignorePaths.length > 0
						? ` The organization already ignores ${parent.ignorePaths.length}.`
						: null}
				</p>
			</div>

			<fieldset className="flex flex-col gap-2">
				<legend className="mb-2 flex w-full items-center justify-between gap-3 text-sm font-medium">
					Lenses
					{repository ? (
						<label className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
							Use the organization&apos;s
							<Switch
								checked={state.categories === null}
								onCheckedChange={(checked) =>
									update({ categories: checked ? null : parentCategories })
								}
							/>
						</label>
					) : null}
				</legend>
				<div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
					{ALL_CATEGORIES.map((category) => {
						const current = state.categories ?? parentCategories
						return (
							<label
								key={category}
								className="flex items-center gap-2 text-sm has-disabled:text-muted-foreground"
							>
								<Checkbox
									disabled={state.categories === null}
									checked={current.includes(category)}
									onCheckedChange={(checked) =>
										update({
											categories: checked
												? [...current, category]
												: current.filter((value) => value !== category),
										})
									}
								/>
								{CATEGORY_LABELS[category]}
							</label>
						)
					})}
				</div>
				<p className="text-xs text-muted-foreground">Issues are only filed under checked lenses.</p>
			</fieldset>

			<div className="grid gap-6 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-severity`}>Inline comments</Label>
					<Select
						items={severityItems}
						value={state.minInlineSeverity}
						onValueChange={(value) => {
							if (isSeverity(value) || value === INHERIT) update({ minInlineSeverity: value })
						}}
					>
						<SelectTrigger id={`${idPrefix}-severity`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(severityItems).map(([value, label]) => (
								<SelectItem key={value} value={value}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						The summary comment lists every issue either way.
					</p>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-feedback`}>Learn from feedback</Label>
					<Select
						items={feedbackItems}
						value={state.feedbackScope}
						onValueChange={(value) => {
							if (isFeedbackScope(value) || value === INHERIT) update({ feedbackScope: value })
						}}
					>
						<SelectTrigger id={`${idPrefix}-feedback`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(feedbackItems).map(([value, label]) => (
								<SelectItem key={value} value={value}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						Skips issues like ones your team downvoted or dismissed. Security and critical issues
						are always posted.
					</p>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-limit`}>Daily limit per repository</Label>
					<Input
						id={`${idPrefix}-limit`}
						type="number"
						inputMode="numeric"
						min={1}
						max={DAILY_LIMIT_MAX}
						step={1}
						placeholder={limitPlaceholder(parent.dailyLimit)}
						value={state.dailyLimit}
						onChange={(event) => update({ dailyLimit: event.target.value })}
					/>
					<p className="text-xs text-muted-foreground">
						Reviews a repository may start per UTC day.
					</p>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-per-pr`}>Reviews per pull request</Label>
					<Input
						id={`${idPrefix}-per-pr`}
						type="number"
						inputMode="numeric"
						min={1}
						max={AUTOMATIC_LIMIT_MAX}
						step={1}
						placeholder={limitPlaceholder(parent.automaticReviewLimit)}
						value={state.automaticReviewLimit}
						onChange={(event) => update({ automaticReviewLimit: event.target.value })}
					/>
					<p className="text-xs text-muted-foreground">
						After this many, pushes stop starting reviews. Mention the reviewer with{" "}
						<InlineCode>review</InlineCode> to run one anyway.
					</p>
				</div>
			</div>

			{repository ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-drafts`}>Draft pull requests</Label>
					<Select
						items={draftItems}
						value={state.reviewDrafts}
						onValueChange={(value) => {
							if (value === INHERIT || value === "on" || value === "off")
								update({ reviewDrafts: value })
						}}
					>
						<SelectTrigger id={`${idPrefix}-drafts`} className="w-full sm:w-1/2">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(draftItems).map(([value, label]) => (
								<SelectItem key={value} value={value}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : (
				<label htmlFor={`${idPrefix}-drafts`} className="flex items-center justify-between gap-3">
					<span className="flex flex-col gap-0.5">
						<span className="text-sm font-medium">Review drafts</span>
						<span className="text-xs text-muted-foreground">
							Draft pull requests are skipped unless this is on.
						</span>
					</span>
					<Switch
						id={`${idPrefix}-drafts`}
						checked={state.reviewDrafts === "on"}
						onCheckedChange={(checked) => update({ reviewDrafts: checked ? "on" : "off" })}
					/>
				</label>
			)}

			{error !== null ? (
				<p className="text-xs text-severity-error" role="alert">
					{error}
				</p>
			) : problem !== null && dirty ? (
				<p className="text-xs text-muted-foreground">{problem}</p>
			) : null}

			<div className="flex items-center justify-end gap-3 border-t pt-4">
				{!isAdmin ? (
					<p className="mr-auto text-xs text-muted-foreground">
						Only organization admins can change these settings.
					</p>
				) : null}
				<Button
					variant="outline"
					onClick={() => {
						setState(saved)
						setError(null)
					}}
					disabled={!dirty || saving}
				>
					Reset
				</Button>
				<Button onClick={handleSave} disabled={!isAdmin || !dirty || problem !== null || saving}>
					{saving ? <Spinner className="size-3.5" /> : null}
					Save
				</Button>
			</div>
		</fieldset>
	)
}
