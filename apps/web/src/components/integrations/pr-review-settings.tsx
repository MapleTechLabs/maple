import { useState } from "react"
import { Exit, Schema } from "effect"
import {
	GithubPrReviewConfigRequest,
	PrReviewCategory,
	PrReviewFeedbackScope,
	PrReviewRepositoryConfig,
	PrReviewSeverity,
	type GithubRepoSummary,
	type PrReviewListItem,
	type PrReviewSkipReason,
} from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@maple/ui/components/ui/tabs"
import { Textarea } from "@maple/ui/components/ui/textarea"
import { toastManager } from "@maple/ui/components/ui/toast"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"

import {
	CircleCheckIcon,
	CircleWarningIcon,
	ClockIcon,
	ExternalLinkIcon,
	GearIcon,
	LoaderIcon,
} from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { errorMessage } from "@/lib/error-toast"
import { MapleApiAtomClient, retainedQuery } from "@/lib/services/common/atom-client"

const INSTRUCTIONS_MAX = 4_000
const IGNORE_PATH_MAX = 200
const DAILY_LIMIT_MAX = 500
const AUTOMATIC_LIMIT_MAX = 50
/** How often the review list refetches while a review is queued or running. */
const REVIEWS_POLL_MS = 5_000

const CATEGORY_LABELS = {
	correctness: "Correctness",
	security: "Security",
	performance: "Performance",
	observability: "Observability",
	convention: "Conventions",
	tests: "Tests",
	maintainability: "Maintainability",
} satisfies Record<PrReviewCategory, string>
const ALL_CATEGORIES = PrReviewCategory.literals

const SEVERITY_LABELS = {
	critical: "Critical only",
	warn: "Warn and critical",
	info: "Every finding",
} satisfies Record<PrReviewSeverity, string>
const isSeverity = Schema.is(PrReviewSeverity)

const FEEDBACK_LABELS = {
	organization: "Whole organization",
	repository: "This repository",
	off: "Off",
} satisfies Record<PrReviewFeedbackScope, string>
const isFeedbackScope = Schema.is(PrReviewFeedbackScope)

const SKIP_LABELS = {
	disabled: "reviews off",
	draft: "draft",
	bot_author: "bot author",
	action: "not reviewed for this event",
	no_head_sha: "no head commit",
	quota: "daily limit reached",
	duplicate: "already reviewed",
	superseded: "a newer push was reviewed",
	agent_unavailable: "reviewer unavailable",
	not_rolled_out: "not enabled for this organization",
	automatic_limit: "pull request limit reached",
} satisfies Record<PrReviewSkipReason, string>

const configKey = (repo: GithubRepoSummary) => `githubPrReviewConfig:${repo.id}`
const reviewsKey = (repo: GithubRepoSummary) => `githubPrReviews:${repo.id}`

/** Opens a repository's review settings and recent reviews. Shown once reviews are on. */
export function PrReviewSettingsButton({ repo }: { repo: GithubRepoSummary }) {
	const [open, setOpen] = useState(false)

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<Button
				size="icon-xs"
				variant="ghost"
				className="shrink-0 text-muted-foreground"
				aria-label={`Review settings for ${repo.fullName}`}
				title="Review settings"
				onClick={() => setOpen(true)}
			>
				<GearIcon size={14} />
			</Button>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Pull request review</DialogTitle>
					<DialogDescription>{repo.fullName}</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<Tabs defaultValue="settings">
						<TabsList variant="underline">
							<TabsTab value="settings">Settings</TabsTab>
							<TabsTab value="reviews">Recent reviews</TabsTab>
						</TabsList>
						<TabsPanel value="settings" className="pt-3">
							<ConfigSection repo={repo} />
						</TabsPanel>
						<TabsPanel value="reviews" className="pt-3">
							<ReviewsSection repo={repo} />
						</TabsPanel>
					</Tabs>
				</DialogPanel>
			</DialogContent>
		</Dialog>
	)
}

function ConfigSection({ repo }: { repo: GithubRepoSummary }) {
	const result = useAtomValue(
		retainedQuery("integrations", "githubGetPrReviewConfig", {
			params: { repositoryId: repo.id },
			reactivityKeys: [configKey(repo)],
		}),
	)

	return Result.builder(result)
		.onInitial(() => (
			<div className="space-y-3">
				<Skeleton className="h-20 w-full" />
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-8 w-1/2" />
			</div>
		))
		.onError((error) => (
			<p className="text-xs text-severity-error" role="alert">
				{errorMessage(error, "Failed to load review settings.")}
			</p>
		))
		.onSuccess((response) => <ConfigForm repo={repo} config={response.config} />)
		.render()
}

interface FormState {
	readonly instructions: string
	readonly ignorePaths: string
	readonly categories: ReadonlyArray<PrReviewCategory>
	readonly minInlineSeverity: PrReviewSeverity
	readonly reviewDrafts: boolean
	readonly dailyLimit: string
	readonly automaticReviewLimit: string
	readonly feedbackScope: PrReviewFeedbackScope
}

const stateFromConfig = (config: PrReviewRepositoryConfig): FormState => ({
	instructions: config.instructions ?? "",
	ignorePaths: (config.ignorePaths ?? []).join("\n"),
	categories: config.categories ?? ALL_CATEGORIES,
	minInlineSeverity: config.minInlineSeverity ?? "warn",
	reviewDrafts: config.reviewDrafts ?? false,
	dailyLimit: config.dailyLimit === undefined ? "" : String(config.dailyLimit),
	automaticReviewLimit:
		config.automaticReviewLimit === undefined ? "" : String(config.automaticReviewLimit),
	feedbackScope: config.feedbackScope ?? "organization",
})

const sameState = (a: FormState, b: FormState) =>
	a.instructions === b.instructions &&
	a.ignorePaths === b.ignorePaths &&
	a.minInlineSeverity === b.minInlineSeverity &&
	a.reviewDrafts === b.reviewDrafts &&
	a.dailyLimit === b.dailyLimit &&
	a.automaticReviewLimit === b.automaticReviewLimit &&
	a.feedbackScope === b.feedbackScope &&
	a.categories.length === b.categories.length &&
	a.categories.every((category) => b.categories.includes(category))

const parseIgnorePaths = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)

/** The first problem that would make the server reject the form, if any. */
const validate = (state: FormState): string | null => {
	if (state.instructions.length > INSTRUCTIONS_MAX)
		return `Instructions are limited to ${INSTRUCTIONS_MAX} characters.`
	if (parseIgnorePaths(state.ignorePaths).some((path) => path.length > IGNORE_PATH_MAX))
		return `Each ignored path is limited to ${IGNORE_PATH_MAX} characters.`
	if (state.categories.length === 0) return "Pick at least one lens."
	const limit = state.dailyLimit.trim()
	if (limit !== "") {
		const value = Number(limit)
		if (!Number.isInteger(value) || value < 1 || value > DAILY_LIMIT_MAX)
			return `Daily limit must be a whole number from 1 to ${DAILY_LIMIT_MAX}.`
	}
	const perPullRequest = state.automaticReviewLimit.trim()
	if (perPullRequest !== "") {
		const value = Number(perPullRequest)
		if (!Number.isInteger(value) || value < 1 || value > AUTOMATIC_LIMIT_MAX)
			return `Reviews per pull request must be a whole number from 1 to ${AUTOMATIC_LIMIT_MAX}.`
	}
	return null
}

/** Defaults are omitted rather than stored, so a later change to a default reaches this repo. */
const configFromState = (state: FormState) => {
	const instructions = state.instructions.trim()
	const ignorePaths = parseIgnorePaths(state.ignorePaths)
	const limit = state.dailyLimit.trim()
	const perPullRequest = state.automaticReviewLimit.trim()
	return new PrReviewRepositoryConfig({
		...(instructions === "" ? undefined : { instructions }),
		...(ignorePaths.length === 0 ? undefined : { ignorePaths }),
		// Absent means every lens, including any added later.
		...(state.categories.length === ALL_CATEGORIES.length
			? undefined
			: { categories: ALL_CATEGORIES.filter((category) => state.categories.includes(category)) }),
		...(state.minInlineSeverity === "warn" ? undefined : { minInlineSeverity: state.minInlineSeverity }),
		...(state.reviewDrafts ? { reviewDrafts: true } : undefined),
		...(limit === "" ? undefined : { dailyLimit: Number(limit) }),
		...(perPullRequest === "" ? undefined : { automaticReviewLimit: Number(perPullRequest) }),
		...(state.feedbackScope === "organization" ? undefined : { feedbackScope: state.feedbackScope }),
	})
}

function ConfigForm({ repo, config }: { repo: GithubRepoSummary; config: PrReviewRepositoryConfig }) {
	const isAdmin = useIsOrgAdmin()
	const saveConfig = useAtomSet(MapleApiAtomClient.mutation("integrations", "githubSetPrReviewConfig"), {
		mode: "promiseExit",
	})
	const [state, setState] = useState(() => stateFromConfig(config))
	const [saved, setSaved] = useState(() => stateFromConfig(config))
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	// What was last sent, so a refetch landing after the save keeps any edit made since.
	const [submitted, setSubmitted] = useState<FormState | null>(null)
	// A refetched config replaces the form unless it was edited after Save; adjusted during render.
	const [seenConfig, setSeenConfig] = useState(config)
	if (seenConfig !== config) {
		setSeenConfig(config)
		setSaved(stateFromConfig(config))
		if (submitted === null || sameState(state, submitted)) setState(stateFromConfig(config))
		setSubmitted(null)
	}

	const problem = validate(state)
	const dirty = !sameState(state, saved)
	const id = `pr-review-${repo.id}`

	const update = (patch: Partial<FormState>) => {
		setState((prev) => ({ ...prev, ...patch }))
		setError(null)
	}

	async function handleSave() {
		setSaving(true)
		setSubmitted(state)
		setError(null)
		const result = await saveConfig({
			params: { repositoryId: repo.id },
			payload: new GithubPrReviewConfigRequest({ config: configFromState(state) }),
			reactivityKeys: [configKey(repo)],
		})
		setSaving(false)
		if (Exit.isSuccess(result)) {
			toastManager.add({ title: `Review settings saved for ${repo.fullName}`, type: "success" })
			return
		}
		setError(errorMessage(result, "Failed to save review settings."))
	}

	// Frozen while saving: a refetch after the save would replace any edit made in the meantime.
	return (
		<fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${id}-instructions`}>Instructions</Label>
				<Textarea
					id={`${id}-instructions`}
					size="sm"
					value={state.instructions}
					maxLength={INSTRUCTIONS_MAX}
					placeholder="Rules the review applies on top of its defaults."
					controlClassName="max-h-48"
					onChange={(event) => update({ instructions: event.target.value })}
				/>
				<p className="text-xs text-muted-foreground">
					Read alongside the repository&apos;s own .maple/review.md. {state.instructions.length}/
					{INSTRUCTIONS_MAX}
				</p>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${id}-ignore`}>Ignored paths</Label>
				<Textarea
					id={`${id}-ignore`}
					size="sm"
					value={state.ignorePaths}
					placeholder={"generated/\n*.pb.go\napps/**/routeTree.gen.ts"}
					controlClassName="max-h-40 font-mono"
					onChange={(event) => update({ ignorePaths: event.target.value })}
				/>
				<p className="text-xs text-muted-foreground">
					One per line. The review never reads files that match.
				</p>
			</div>

			<fieldset className="flex flex-col gap-2">
				<legend className="mb-2 text-sm font-medium">Lenses</legend>
				<div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
					{ALL_CATEGORIES.map((category) => (
						<label key={category} className="flex items-center gap-2 text-sm">
							<Checkbox
								checked={state.categories.includes(category)}
								onCheckedChange={(checked) =>
									update({
										categories: checked
											? [...state.categories, category]
											: state.categories.filter((current) => current !== category),
									})
								}
							/>
							{CATEGORY_LABELS[category]}
						</label>
					))}
				</div>
				<p className="text-xs text-muted-foreground">Findings are only filed under checked lenses.</p>
			</fieldset>

			<div className="grid gap-5 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${id}-severity`}>Inline comments</Label>
					<Select
						items={SEVERITY_LABELS}
						value={state.minInlineSeverity}
						onValueChange={(value) => {
							if (isSeverity(value)) update({ minInlineSeverity: value })
						}}
					>
						<SelectTrigger id={`${id}-severity`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PrReviewSeverity.literals.map((severity) => (
								<SelectItem key={severity} value={severity}>
									{SEVERITY_LABELS[severity]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						The summary comment lists every finding either way.
					</p>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${id}-limit`}>Daily limit</Label>
					<Input
						id={`${id}-limit`}
						type="number"
						inputMode="numeric"
						min={1}
						max={DAILY_LIMIT_MAX}
						step={1}
						placeholder="No limit"
						value={state.dailyLimit}
						onChange={(event) => update({ dailyLimit: event.target.value })}
					/>
					<p className="text-xs text-muted-foreground">
						Reviews per UTC day. The organization limit still applies.
					</p>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${id}-per-pr`}>Reviews per pull request</Label>
					<Input
						id={`${id}-per-pr`}
						type="number"
						inputMode="numeric"
						min={1}
						max={AUTOMATIC_LIMIT_MAX}
						step={1}
						placeholder="No limit"
						value={state.automaticReviewLimit}
						onChange={(event) => update({ automaticReviewLimit: event.target.value })}
					/>
					<p className="text-xs text-muted-foreground">
						After this many, pushes stop starting reviews. Comment @maple review to run one.
					</p>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${id}-feedback`}>Learn from feedback</Label>
					<Select
						items={FEEDBACK_LABELS}
						value={state.feedbackScope}
						onValueChange={(value) => {
							if (isFeedbackScope(value)) update({ feedbackScope: value })
						}}
					>
						<SelectTrigger id={`${id}-feedback`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PrReviewFeedbackScope.literals.map((scope) => (
								<SelectItem key={scope} value={scope}>
									{FEEDBACK_LABELS[scope]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						Skips findings like ones your team downvoted or dismissed. Security and critical
						findings are always posted.
					</p>
				</div>
			</div>

			<label htmlFor={`${id}-drafts`} className="flex items-center justify-between gap-3">
				<span className="flex flex-col gap-0.5">
					<span className="text-sm font-medium">Review drafts</span>
					<span className="text-xs text-muted-foreground">
						Draft pull requests are skipped unless this is on.
					</span>
				</span>
				<Switch
					id={`${id}-drafts`}
					checked={state.reviewDrafts}
					onCheckedChange={(checked) => update({ reviewDrafts: checked })}
				/>
			</label>

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
					{saving ? <LoaderIcon size={14} className="animate-spin" /> : null}
					Save
				</Button>
			</div>
		</fieldset>
	)
}

function ReviewsSection({ repo }: { repo: GithubRepoSummary }) {
	const query = retainedQuery("integrations", "githubListPrReviews", {
		params: { repositoryId: repo.id },
		reactivityKeys: [reviewsKey(repo)],
	})
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)
	const active = Result.builder(result)
		.onSuccess((response) =>
			response.reviews.some((review) => review.status === "queued" || review.status === "running"),
		)
		.orElse(() => false)
	// A failed poll keeps retrying while the section is open, rather than stopping on the error.
	useIntervalRefresh(refresh, { intervalMs: REVIEWS_POLL_MS, enabled: active || Result.isFailure(result) })

	return Result.builder(result)
		.onInitial(() => (
			<div className="space-y-2">
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-11 w-full" />
				))}
			</div>
		))
		.onError((error) => (
			<p className="text-xs text-severity-error" role="alert">
				{errorMessage(error, "Failed to load recent reviews.")}
			</p>
		))
		.onSuccess((response) =>
			response.reviews.length === 0 ? (
				<p className="py-6 text-center text-sm text-muted-foreground">
					Reviews appear here after the next pull request is opened.
				</p>
			) : (
				<ul className="-mx-1 divide-y">
					{response.reviews.map((review) => (
						<ReviewRow key={review.id} review={review} />
					))}
				</ul>
			),
		)
		.render()
}

interface Outcome {
	readonly label: string
	readonly tone: string
	readonly Icon: typeof CircleCheckIcon
	readonly spin?: boolean
}

const outcomeOf = (review: PrReviewListItem): Outcome => {
	switch (review.status) {
		case "queued":
			return { label: "Queued", tone: "text-muted-foreground", Icon: ClockIcon }
		case "running":
			return { label: "Reviewing", tone: "text-info-foreground", Icon: LoaderIcon, spin: true }
		case "failed":
			return { label: "Failed", tone: "text-destructive-foreground", Icon: CircleWarningIcon }
		case "skipped":
			return { label: "Skipped", tone: "text-muted-foreground", Icon: ClockIcon }
		case "completed":
			return review.verdict === "issues"
				? { label: "Issues", tone: "text-warning-foreground", Icon: CircleWarningIcon }
				: review.verdict === "not_applicable"
					? { label: "Nothing to review", tone: "text-muted-foreground", Icon: CircleCheckIcon }
					: { label: "Clean", tone: "text-success-foreground", Icon: CircleCheckIcon }
	}
}

function ReviewRow({ review }: { review: PrReviewListItem }) {
	const outcome = outcomeOf(review)
	const Icon = outcome.Icon
	const problem =
		review.error !== null
			? review.error
			: review.publishError !== null
				? `Not posted to GitHub: ${review.publishError}`
				: null

	return (
		<li className="flex items-start gap-3 px-1 py-2.5">
			<Icon
				size={15}
				className={`mt-0.5 shrink-0 ${outcome.tone} ${outcome.spin ? "animate-spin" : ""}`}
			/>
			<div className="min-w-0 flex-1">
				<a
					href={review.url}
					target="_blank"
					rel="noreferrer"
					className="group flex max-w-full items-center gap-1.5 text-sm hover:underline"
				>
					<span className="shrink-0 text-muted-foreground">#{review.number}</span>
					<span className="truncate font-medium">{review.title ?? "Untitled pull request"}</span>
					<ExternalLinkIcon
						size={12}
						className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
					/>
				</a>
				<div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
					<span className={outcome.tone}>{outcome.label}</span>
					{review.status === "skipped" && review.skipReason !== null ? (
						<span>· {SKIP_LABELS[review.skipReason]}</span>
					) : null}
					{/* Both scores or neither, in a fixed order, so the list scans down one column. */}
					{review.status === "completed" ? (
						<>
							<span title="Confidence the change is safe to merge">
								· confidence{" "}
								<span className="text-foreground">{review.confidence ?? "–"}</span>/5
							</span>
							<span title="Quality: 100 minus a fixed penalty per open finding">
								· quality <span className="text-foreground">{review.score ?? "–"}</span>/100
							</span>
						</>
					) : null}
					{review.status === "completed" ? (
						<span>
							· {review.findings === 0 ? "no" : review.findings}{" "}
							{review.findings === 1 ? "finding" : "findings"}
						</span>
					) : null}
					<span>· {formatRelativeFrom(review.createdAt)}</span>
					{review.commentUrl !== null ? (
						<>
							<span>·</span>
							<a
								href={review.commentUrl}
								target="_blank"
								rel="noreferrer"
								className="underline underline-offset-2 hover:text-foreground"
							>
								Comment
							</a>
						</>
					) : null}
				</div>
				{problem !== null ? (
					<p className="truncate text-xs text-muted-foreground" title={problem}>
						{problem}
					</p>
				) : null}
			</div>
		</li>
	)
}
