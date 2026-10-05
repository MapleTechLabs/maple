import { useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Exit, Schema } from "effect"
import {
	GithubPrReviewConfigRequest,
	GithubPrReviewSettingsRequest,
	GithubSetPrReviewRequest,
	PR_REVIEW_MODELS,
	PrReviewModel,
	PrReviewOrgSettings,
	type GithubRepoSummary,
	PrReviewRepositoryConfig,
} from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { toastManager } from "@maple/ui/components/ui/toast"

import { ErrorState } from "@/components/common/error-state"
import { ExternalLinkIcon, GearIcon, GithubIcon } from "@/components/icons"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { errorMessage } from "@/lib/error-toast"
import { currentRegion } from "@/lib/region"
import { MapleApiAtomClient, retainedQuery } from "@/lib/services/common/atom-client"

import { ReviewRulesForm } from "./review-rules-form"

const SETTINGS_KEY = "githubPrReviewSettings"
const STATUS_KEY = "githubIntegrationStatus"
const configKey = (repo: GithubRepoSummary) => `githubPrReviewConfig:${repo.id}`

const DEFAULT_MODEL = "default"
/** The EU instance only serves models with an in-region provider. */
const MODEL_OPTIONS = PR_REVIEW_MODELS.filter((model) => currentRegion !== "eu" || model.eu)
const DEFAULT_MODEL_LABEL = "Maple default"
const MODEL_LABELS = Object.fromEntries([
	[DEFAULT_MODEL, DEFAULT_MODEL_LABEL],
	...MODEL_OPTIONS.map((model) => [model.id, model.label]),
])
const isModel = Schema.is(PrReviewModel)
// One instance, so the form's "the config changed" check does not fire on every render.
const EMPTY_CONFIG = new PrReviewRepositoryConfig({})

/** Organization settings first, since every repository inherits them; then the repositories. */
export function CodeReviewSettingsView() {
	const query = retainedQuery("integrations", "githubGetPrReviewSettings", {
		reactivityKeys: [SETTINGS_KEY],
	})
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)

	return Result.builder(result)
		.onInitial(() => (
			<div className="flex flex-col gap-6">
				<Skeleton className="h-20 w-full rounded-xl" />
				<Skeleton className="h-[520px] w-full rounded-xl" />
			</div>
		))
		.onError((error) => (
			<ErrorState error={error} title="Failed to load review settings" onRetry={refresh} />
		))
		.onSuccess((response) => (
			<div className="flex flex-col gap-8">
				<Section
					title="Reviewer"
					description="The model every review and reply in this organization runs on."
				>
					<ModelSetting settings={response.settings} />
				</Section>
				<Section
					title="Default review rules"
					description="Every repository starts from these. A repository can override any of them."
				>
					<div className="rounded-xl border bg-card p-5">
						<ReviewRulesDefaults settings={response.settings} />
					</div>
				</Section>
				<Section
					title="Repositories"
					description="Pick which repositories get reviews, and tune any of them on its own."
				>
					<RepositoriesSection inherited={response.settings.defaults} />
				</Section>
			</div>
		))
		.render()
}

function Section({
	title,
	description,
	children,
}: {
	title: string
	description: string
	children: ReactNode
}) {
	return (
		<section className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-8">
			<div className="flex flex-col gap-1">
				<h2 className="text-sm font-medium">{title}</h2>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			<div className="min-w-0">{children}</div>
		</section>
	)
}

function useSaveSettings() {
	const save = useAtomSet(MapleApiAtomClient.mutation("integrations", "githubSetPrReviewSettings"), {
		mode: "promiseExit",
	})
	return (settings: PrReviewOrgSettings) =>
		save({ payload: new GithubPrReviewSettingsRequest({ settings }), reactivityKeys: [SETTINGS_KEY] })
}

function ModelSetting({ settings }: { settings: PrReviewOrgSettings }) {
	const isAdmin = useIsOrgAdmin()
	const save = useSaveSettings()
	const [saving, setSaving] = useState(false)
	const current =
		settings.model !== undefined && MODEL_OPTIONS.some((model) => model.id === settings.model)
			? settings.model
			: DEFAULT_MODEL

	async function handleChange(value: unknown) {
		if (value === current) return
		const model = isModel(value) ? value : undefined
		setSaving(true)
		// The defaults ride along: the settings are one row, written whole.
		const result = await save(
			new PrReviewOrgSettings({
				...(model === undefined ? undefined : { model }),
				...(settings.defaults === undefined ? undefined : { defaults: settings.defaults }),
			}),
		)
		setSaving(false)
		toastManager.add(
			Exit.isSuccess(result)
				? { title: `Reviews now run on ${MODEL_LABELS[model ?? DEFAULT_MODEL]}`, type: "success" }
				: { title: errorMessage(result, "Failed to save the review model."), type: "error" },
		)
	}

	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-5 py-4">
			<div className="leading-tight">
				<div className="text-sm font-medium">Review model</div>
				<div className="text-xs text-muted-foreground">Runs pull request reviews and replies.</div>
			</div>
			<Select
				items={MODEL_LABELS}
				value={current}
				onValueChange={handleChange}
				disabled={!isAdmin || saving}
			>
				<SelectTrigger
					size="sm"
					className="w-56"
					aria-label="Review model"
					title={isAdmin ? undefined : "Only admins can change the review model"}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={DEFAULT_MODEL}>{DEFAULT_MODEL_LABEL}</SelectItem>
					{MODEL_OPTIONS.map((model) => (
						<SelectItem key={model.id} value={model.id}>
							{model.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	)
}

function ReviewRulesDefaults({ settings }: { settings: PrReviewOrgSettings }) {
	const save = useSaveSettings()
	return (
		<ReviewRulesForm
			mode="organization"
			idPrefix="code-review-defaults"
			config={settings.defaults ?? EMPTY_CONFIG}
			onSave={async (defaults) => {
				const result = await save(
					new PrReviewOrgSettings({
						...(settings.model === undefined ? undefined : { model: settings.model }),
						defaults,
					}),
				)
				if (Exit.isFailure(result)) return errorMessage(result, "Failed to save the default rules.")
				toastManager.add({ title: "Default review rules saved", type: "success" })
				return null
			}}
		/>
	)
}

function RepositoriesSection({ inherited }: { inherited: PrReviewRepositoryConfig | undefined }) {
	const query = retainedQuery("integrations", "githubStatus", { reactivityKeys: [STATUS_KEY] })
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)

	return Result.builder(result)
		.onInitial(() => <Skeleton className="h-40 w-full rounded-xl" />)
		.onError((error) => (
			<ErrorState error={error} title="Failed to load repositories" onRetry={refresh} />
		))
		.onSuccess((status) => {
			const repositories = status.repositories.filter((repo) => repo.status === "active")
			if (!status.connected || repositories.length === 0)
				return (
					<div className="flex flex-col items-start gap-3 rounded-xl border border-dashed px-5 py-6">
						<div className="flex items-center gap-2 text-sm font-medium">
							<GithubIcon size={16} aria-hidden />
							{status.connected
								? "No repositories yet"
								: "Connect GitHub to review pull requests"}
						</div>
						<p className="text-sm text-muted-foreground">
							{status.connected
								? "Grant the Maple GitHub App access to a repository, and it appears here."
								: "Maple reviews pull requests through its GitHub App. Install it on the repositories you want reviewed."}
						</p>
						<Button variant="outline" size="sm" render={<Link to="/integrations" />}>
							{status.connected ? "Manage GitHub access" : "Connect GitHub"}
						</Button>
					</div>
				)
			const enabled = repositories.filter((repo) => repo.prReviewEnabled).length
			return (
				<div className="overflow-hidden rounded-xl border bg-card">
					<div className="flex items-center justify-between gap-3 border-b px-5 py-3 text-xs text-muted-foreground">
						<span>
							{enabled} of {repositories.length}{" "}
							{repositories.length === 1 ? "repository" : "repositories"} reviewed
						</span>
						<Link to="/integrations" className="hover:text-foreground hover:underline">
							Manage GitHub access
						</Link>
					</div>
					<ul className="divide-y">
						{repositories.map((repo) => (
							<RepositoryRow key={repo.id} repo={repo} inherited={inherited} />
						))}
					</ul>
				</div>
			)
		})
		.render()
}

function RepositoryRow({
	repo,
	inherited,
}: {
	repo: GithubRepoSummary
	inherited: PrReviewRepositoryConfig | undefined
}) {
	const isAdmin = useIsOrgAdmin()
	const setPrReview = useAtomSet(MapleApiAtomClient.mutation("integrations", "githubSetPrReview"), {
		mode: "promiseExit",
	})
	const [enabled, setEnabled] = useState(repo.prReviewEnabled)
	const [busy, setBusy] = useState(false)
	const [open, setOpen] = useState(false)
	// A fresh server value wins over the optimistic one; adjusted during render, not in an effect.
	const [seenServer, setSeenServer] = useState(repo.prReviewEnabled)
	if (seenServer !== repo.prReviewEnabled) {
		setSeenServer(repo.prReviewEnabled)
		setEnabled(repo.prReviewEnabled)
	}
	const id = `code-review-repo-${repo.id}`

	async function handleToggle(next: boolean) {
		// Ignored while a change is in flight, rather than disabling the switch, which would drop
		// keyboard focus mid-toggle.
		if (busy) return
		setEnabled(next)
		setBusy(true)
		const result = await setPrReview({
			params: { repositoryId: repo.id },
			payload: new GithubSetPrReviewRequest({ enabled: next }),
			reactivityKeys: [STATUS_KEY],
		})
		setBusy(false)
		if (Exit.isSuccess(result)) {
			toastManager.add({
				title: next
					? `Maple will review pull requests on ${repo.fullName}`
					: `Reviews off for ${repo.fullName}`,
				type: "success",
			})
			return
		}
		setEnabled(!next)
		toastManager.add({
			title: errorMessage(result, "Failed to change pull request reviews."),
			type: "error",
		})
	}

	return (
		<li className="flex items-center gap-3 px-5 py-3">
			<GithubIcon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<a
					href={repo.htmlUrl}
					target="_blank"
					rel="noreferrer"
					className="group inline-flex min-w-0 items-center gap-1 text-sm font-medium hover:underline"
				>
					<span className="truncate">{repo.fullName}</span>
					<ExternalLinkIcon
						size={12}
						className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
					/>
				</a>
				{repo.isPrivate ? (
					<Badge variant="outline" size="sm" className="shrink-0">
						Private
					</Badge>
				) : null}
			</div>
			<Dialog open={open} onOpenChange={setOpen}>
				<Button
					size="sm"
					variant="ghost"
					className="shrink-0 text-muted-foreground"
					onClick={() => setOpen(true)}
					disabled={!enabled}
					title={enabled ? "Repository overrides" : "Turn reviews on to configure this repository"}
				>
					<GearIcon size={14} aria-hidden />
					Configure
				</Button>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Repository rules</DialogTitle>
						<DialogDescription>
							{repo.fullName}. Anything left on the organization default follows the default
							review rules.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<RepositoryConfig repo={repo} inherited={inherited} />
					</DialogPanel>
				</DialogContent>
			</Dialog>
			<Switch
				id={id}
				aria-label={`Review pull requests on ${repo.fullName}`}
				checked={enabled}
				aria-busy={busy}
				disabled={!isAdmin}
				onCheckedChange={(next) => void handleToggle(next)}
			/>
		</li>
	)
}

function RepositoryConfig({
	repo,
	inherited,
}: {
	repo: GithubRepoSummary
	inherited: PrReviewRepositoryConfig | undefined
}) {
	const result = useAtomValue(
		retainedQuery("integrations", "githubGetPrReviewConfig", {
			params: { repositoryId: repo.id },
			reactivityKeys: [configKey(repo)],
		}),
	)
	const save = useAtomSet(MapleApiAtomClient.mutation("integrations", "githubSetPrReviewConfig"), {
		mode: "promiseExit",
	})

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
				{errorMessage(error, "Failed to load the repository's rules.")}
			</p>
		))
		.onSuccess((response) => (
			<ReviewRulesForm
				mode="repository"
				idPrefix={`code-review-${repo.id}`}
				config={response.config}
				inherited={inherited}
				onSave={async (config) => {
					const saved = await save({
						params: { repositoryId: repo.id },
						payload: new GithubPrReviewConfigRequest({ config }),
						reactivityKeys: [configKey(repo)],
					})
					if (Exit.isFailure(saved))
						return errorMessage(saved, "Failed to save the repository's rules.")
					toastManager.add({ title: `Rules saved for ${repo.fullName}`, type: "success" })
					return null
				}}
			/>
		))
		.render()
}
