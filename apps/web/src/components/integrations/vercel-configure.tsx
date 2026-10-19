import { useId, useState } from "react"
import type React from "react"
import { Exit, Option, Schema } from "effect"
import {
	VercelConnectRequest,
	VercelDiscoverRequest,
	VercelSettingsRequest,
	type VercelDiscoverResponse,
	type VercelIntegrationStatus,
	type VercelTeam,
} from "@maple/domain/http"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@maple/ui/components/ui/field"
import { Input } from "@maple/ui/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@maple/ui/components/ui/radio-group"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Switch } from "@maple/ui/components/ui/switch"
import { toastManager } from "@maple/ui/components/ui/toast"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { AlertWarningIcon, CircleInfoIcon, VercelIcon } from "@/components/icons"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { useAtomSet } from "@/lib/effect-atom"
import { errorMessage } from "@/lib/error-toast"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { GcpExternalLink } from "./gcp-primitives"
import {
	DEFAULT_VERCEL_DRAFT,
	VERCEL_SAMPLING_RATES,
	draftOf,
	draftProblem,
	samplingLabel,
	settingsPatch,
	stoppedByDraft,
	type VercelDraft,
} from "./vercel-model"

const TOKENS_URL = "https://vercel.com/account/settings/tokens"
const REACTIVITY = ["vercelIntegrationStatus"]
const SMALL = "text-xs/5 text-pretty text-muted-foreground"
const TITLE = "text-sm/5 font-medium"

const decodeDiscover = Schema.decodeUnknownOption(VercelDiscoverRequest)

/** What the configuration dialog is open on. */
export type VercelConfigureTarget = "connect" | "configure" | "token"

type Project = VercelDiscoverResponse["projects"][number]

function Header({ title }: { title: React.ReactNode }) {
	return (
		<DialogHeader>
			<DialogTitle className="flex items-center gap-3 pr-8 text-lg">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/60">
					<VercelIcon size={16} className="text-foreground" />
				</span>
				<span className="min-w-0">{title}</span>
			</DialogTitle>
		</DialogHeader>
	)
}

/** One short line at the footer's start: what the primary button does, and when. */
function FooterNote({ children }: { children: React.ReactNode }) {
	return <p className={cn(SMALL, "sm:mr-auto sm:self-center")}>{children}</p>
}

/** The token field with how to make a good one. */
export function VercelTokenFields({
	token,
	onToken,
	error,
}: {
	token: string
	onToken: (token: string) => void
	error: string | null
}) {
	const tooShort = token.trim().length > 0 && Option.isNone(decodeDiscover({ token: token.trim() }))
	return (
		<div className="flex flex-col gap-4">
			<Field className="items-stretch gap-2" invalid={error !== null || tooShort}>
				<FieldLabel htmlFor="vercel-token">Vercel access token</FieldLabel>
				<Input
					id="vercel-token"
					type="password"
					autoComplete="off"
					spellCheck={false}
					placeholder="Paste a token"
					value={token}
					onChange={(event) => onToken(event.target.value)}
				/>
				{error !== null ? (
					<FieldError match role="alert" className="leading-5 text-pretty">
						{error}
					</FieldError>
				) : tooShort ? (
					<FieldDescription>A Vercel token is between 8 and 512 characters.</FieldDescription>
				) : null}
			</Field>
			<div className="flex flex-col gap-2 rounded-lg border p-3">
				<span className={TITLE}>
					Create one in <GcpExternalLink href={TOKENS_URL}>Vercel account settings</GcpExternalLink>
				</span>
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs/5">
					<dt className="text-foreground">Scope</dt>
					<dd className="text-muted-foreground">The team to monitor, not your whole account</dd>
					<dt className="text-foreground">Expiration</dt>
					<dd className="text-muted-foreground">
						Set one. Maple asks for a new token when it ends.
					</dd>
					<dt className="text-foreground">Plan</dt>
					<dd className="text-muted-foreground">Drains need Vercel Pro or Enterprise</dd>
				</dl>
			</div>
		</div>
	)
}

/** Which team the drains go on, when the token sees several. */
export function VercelTeamFields({
	teams,
	teamId,
	onTeam,
}: {
	teams: ReadonlyArray<VercelTeam>
	teamId: string | null
	onTeam: (teamId: string) => void
}) {
	const headingId = useId()
	return (
		<div className="flex flex-col gap-2">
			<h3 id={headingId} className={TITLE}>
				Which team should Maple watch?
			</h3>
			<RadioGroup
				aria-labelledby={headingId}
				value={teamId ?? ""}
				onValueChange={(value) => onTeam(String(value))}
				className="gap-0 divide-y divide-border overflow-hidden rounded-md border"
			>
				{teams.map((team) => (
					<label
						key={team.id}
						htmlFor={`vercel-team-${team.id}`}
						className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/40"
					>
						<RadioGroupItem value={team.id} id={`vercel-team-${team.id}`} />
						<span className="min-w-0 flex-1 truncate text-sm font-medium">{team.name}</span>
						<span className="font-mono text-xs text-muted-foreground">{team.slug}</span>
					</label>
				))}
			</RadioGroup>
			<p className={SMALL}>One team per Maple organization. Drains are created on the team you pick.</p>
		</div>
	)
}

/** The project picker: every project, or a searchable list to tick. */
function ProjectFields({
	projects,
	draft,
	onDraft,
}: {
	projects: ReadonlyArray<Project>
	draft: VercelDraft
	onDraft: (draft: VercelDraft) => void
}) {
	const headingId = useId()
	const [query, setQuery] = useState("")
	const q = query.trim().toLowerCase()
	const shown = projects.filter((project) => q === "" || project.name.toLowerCase().includes(q))
	const toggle = (id: string, checked: boolean) =>
		onDraft({
			...draft,
			projectIds: checked
				? [...draft.projectIds, id]
				: draft.projectIds.filter((other) => other !== id),
		})

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-3">
				<h3 id={headingId} className={TITLE}>
					Projects
				</h3>
				<ToggleGroup
					variant="outline"
					size="sm"
					aria-labelledby={headingId}
					value={[draft.projectScope]}
					onValueChange={(values) => {
						const next = values.find((value) => value !== draft.projectScope)
						if (next === "all" || next === "some") onDraft({ ...draft, projectScope: next })
					}}
				>
					<ToggleGroupItem value="all">All projects</ToggleGroupItem>
					<ToggleGroupItem value="some">Pick projects</ToggleGroupItem>
				</ToggleGroup>
			</div>
			{draft.projectScope === "all" ? (
				<p className={SMALL}>
					{projects.length === 0
						? "Every project on the team, including ones created later."
						: `All ${countLabel(projects.length, "project")}, and ones created later.`}
				</p>
			) : (
				<div className="flex flex-col overflow-hidden rounded-md border">
					{projects.length > 8 ? (
						<div className="border-b p-2">
							<SearchInput
								value={query}
								onValueChange={setQuery}
								placeholder="Search projects…"
							/>
						</div>
					) : null}
					<ul className="max-h-56 divide-y divide-border/60 overflow-y-auto">
						{shown.map((project) => (
							<li key={project.id}>
								<label
									htmlFor={`vercel-project-${project.id}`}
									className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40"
								>
									<Checkbox
										id={`vercel-project-${project.id}`}
										checked={draft.projectIds.includes(project.id)}
										onCheckedChange={(checked) => toggle(project.id, checked)}
									/>
									<span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
									{project.framework !== null ? (
										<Badge variant="meta" size="xs">
											{project.framework}
										</Badge>
									) : null}
								</label>
							</li>
						))}
						{shown.length === 0 ? (
							<li className={cn(SMALL, "px-3 py-2")}>
								{projects.length === 0
									? "This team has no projects yet."
									: "No project matches."}
							</li>
						) : null}
					</ul>
					<p className={cn(SMALL, "border-t bg-muted/30 px-3 py-1.5")}>
						{draft.projectIds.length} of {countLabel(projects.length, "project")} picked
					</p>
				</div>
			)}
		</div>
	)
}

const SIGNALS = [
	{
		flag: "logsEnabled",
		title: "Logs",
		drain: "Maple logs",
		description: "Requests, functions, edge middleware and builds, with status, path and cache result.",
	},
	{
		flag: "tracesEnabled",
		title: "Traces",
		drain: "Maple traces",
		description: "Deployment traces, and every AI Gateway request with its model, tokens and cost.",
	},
] as const

/** What the drains forward. Shared by connecting and by Configure. */
export function VercelSettingsFields({
	projects,
	draft,
	onDraft,
}: {
	projects: ReadonlyArray<Project>
	draft: VercelDraft
	onDraft: (draft: VercelDraft) => void
}) {
	const id = useId()
	return (
		<div className="flex flex-col gap-5">
			<fieldset className="flex flex-col gap-2">
				<legend className={cn(TITLE, "mb-2")}>What should Vercel send?</legend>
				<div className="divide-y divide-border/60 rounded-lg border">
					{SIGNALS.map((signal) => (
						<div key={signal.flag} className="flex items-start gap-4 p-3">
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<label
									htmlFor={`${id}-${signal.flag}`}
									className="flex items-center gap-2 text-sm font-medium"
								>
									{signal.title}
									<Badge variant="outline" size="xs" className="font-mono">
										{signal.drain}
									</Badge>
								</label>
								<p className={SMALL}>{signal.description}</p>
							</div>
							<Switch
								id={`${id}-${signal.flag}`}
								checked={draft[signal.flag]}
								onCheckedChange={(checked) => onDraft({ ...draft, [signal.flag]: checked })}
							/>
						</div>
					))}
				</div>
			</fieldset>
			<ProjectFields projects={projects} draft={draft} onDraft={onDraft} />
			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-3">
					<label htmlFor={`${id}-sampling`} className={TITLE}>
						Sampling
					</label>
					<Select
						items={VERCEL_SAMPLING_RATES.map((rate) => ({
							value: rate,
							label: samplingLabel(rate),
						}))}
						value={draft.samplingRate}
						onValueChange={(rate) => {
							if (typeof rate === "number") onDraft({ ...draft, samplingRate: rate })
						}}
					>
						<SelectTrigger id={`${id}-sampling`} className="w-44">
							<SelectValue />
						</SelectTrigger>
						<SelectContent alignItemWithTrigger={false}>
							{VERCEL_SAMPLING_RATES.map((rate) => (
								<SelectItem key={rate} value={rate}>
									{samplingLabel(rate)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<p className={SMALL}>Vercel samples before it sends, so a lower rate also lowers its bill.</p>
			</div>
			<VercelCostNote />
		</div>
	)
}

/** Vercel's drain pricing in three facts. */
export function VercelCostNote() {
	return (
		<Alert size="sm" variant="info" role="note">
			<CircleInfoIcon size={14} />
			<AlertTitle>Vercel bills drains on its side</AlertTitle>
			<AlertDescription>
				<ul className="flex flex-col gap-0.5 leading-5">
					<li>
						<span className="font-medium text-foreground">$0.50 per GB</span> of logs and traces
						sent
					</li>
					<li>
						<span className="font-medium text-foreground">$0.05 per 1,000</span> AI Gateway traces
					</li>
					<li>
						Pro and Enterprise plans only.{" "}
						<GcpExternalLink href="https://vercel.com/docs/drains">Pricing</GcpExternalLink>
					</li>
				</ul>
			</AlertDescription>
		</Alert>
	)
}

/** The dialog every step renders in. */
function Frame({
	onClose,
	busy,
	children,
}: {
	onClose: () => void
	busy: boolean
	children: React.ReactNode
}) {
	return (
		<Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
			<DialogContent className="sm:max-w-xl">{children}</DialogContent>
		</Dialog>
	)
}

/** Paste a token, pick a team (skipped when the token sees one), choose what to send, connect. */
function ConnectFlow({ onClose }: { onClose: () => void }) {
	const discover = useAtomSet(MapleInternalAtomClient.mutation("integrations", "vercelDiscover"), {
		mode: "promiseExit",
	})
	const connect = useAtomSet(MapleInternalAtomClient.mutation("integrations", "vercelConnect"), {
		mode: "promiseExit",
	})
	const [token, setToken] = useState("")
	const [teams, setTeams] = useState<ReadonlyArray<VercelTeam> | null>(null)
	const [teamId, setTeamId] = useState<string | null>(null)
	const [projects, setProjects] = useState<ReadonlyArray<Project> | null>(null)
	const [draft, setDraft] = useState<VercelDraft>(DEFAULT_VERCEL_DRAFT)
	const [error, setError] = useState<string | null>(null)

	const request = decodeDiscover({ token: token.trim() })

	const [lookUp, lookingUp] = useAsyncAction(async (forTeam?: string) => {
		if (Option.isNone(request)) return
		setError(null)
		const payload =
			forTeam === undefined
				? new VercelDiscoverRequest({ token: request.value.token })
				: new VercelDiscoverRequest({ token: request.value.token, teamId: forTeam })
		const result = await discover({ payload })
		if (Exit.isFailure(result)) {
			setError(errorMessage(result, "Vercel didn't accept this token."))
			return
		}
		const found = result.value
		setTeams(found.teams)
		const only = found.teams.length === 1 ? found.teams[0]!.id : undefined
		const team = forTeam ?? only
		if (team === undefined) {
			if (found.teams.length === 0)
				setError("This token can't see any team. Create it with a team scope.")
			return
		}
		setTeamId(team)
		setProjects(found.projects)
		setDraft(DEFAULT_VERCEL_DRAFT)
	})

	const [submit, connecting] = useAsyncAction(async () => {
		if (Option.isNone(request) || teamId === null) return
		setError(null)
		const result = await connect({
			payload: new VercelConnectRequest({ token: request.value.token, teamId, ...draft }),
			reactivityKeys: REACTIVITY,
		})
		if (Exit.isFailure(result)) {
			setError(errorMessage(result, "Failed to connect Vercel."))
			return
		}
		toastManager.add({
			type: "success",
			title: `Connected ${result.value.team?.name ?? "Vercel"}`,
			description: "Vercel starts delivering within a minute.",
		})
		onClose()
	})

	const team = teams?.find((candidate) => candidate.id === teamId) ?? null
	const busy = lookingUp || connecting

	if (projects !== null && team !== null) {
		const problem = draftProblem(draft)
		return (
			<Frame onClose={onClose} busy={busy}>
				<Header title={`Connect ${team.name}`} />
				<DialogPanel className="flex flex-col gap-5">
					<VercelSettingsFields projects={projects} draft={draft} onDraft={setDraft} />
					{error !== null ? (
						<Alert size="sm" variant="crit" role="alert">
							<AlertWarningIcon size={14} />
							<AlertTitle>Vercel refused the drains</AlertTitle>
							<AlertDescription className="[overflow-wrap:anywhere]">{error}</AlertDescription>
						</Alert>
					) : null}
				</DialogPanel>
				<DialogFooter>
					<FooterNote>
						{problem ??
							`Creates ${draft.logsEnabled && draft.tracesEnabled ? "2 drains" : "a drain"} on ${team.name} right away.`}
					</FooterNote>
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => {
							setProjects(null)
							setError(null)
							if ((teams?.length ?? 0) < 2) setTeams(null)
						}}
					>
						Back
					</Button>
					<Button disabled={problem !== null} loading={connecting} onClick={() => void submit()}>
						Connect
					</Button>
				</DialogFooter>
			</Frame>
		)
	}

	if (teams !== null && teams.length > 1) {
		return (
			<Frame onClose={onClose} busy={busy}>
				<Header title="Connect Vercel" />
				<DialogPanel className="flex flex-col gap-4">
					<VercelTeamFields teams={teams} teamId={teamId} onTeam={setTeamId} />
					{error !== null ? <FieldError match>{error}</FieldError> : null}
				</DialogPanel>
				<DialogFooter>
					<FooterNote>Nothing changes on Vercel until you connect.</FooterNote>
					<Button variant="outline" disabled={busy} onClick={() => setTeams(null)}>
						Back
					</Button>
					<Button
						disabled={teamId === null}
						loading={lookingUp}
						onClick={() => (teamId === null ? undefined : void lookUp(teamId))}
					>
						Continue
					</Button>
				</DialogFooter>
			</Frame>
		)
	}

	return (
		<Frame onClose={onClose} busy={busy}>
			<Header title="Connect Vercel" />
			<DialogPanel>
				<form
					id="vercel-token-form"
					onSubmit={(event) => {
						event.preventDefault()
						void lookUp()
					}}
				>
					<VercelTokenFields token={token} onToken={setToken} error={error} />
				</form>
			</DialogPanel>
			<DialogFooter>
				<FooterNote>
					Maple lists the token&apos;s teams and projects. Nothing is created yet.
				</FooterNote>
				<DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
				<Button
					type="submit"
					form="vercel-token-form"
					disabled={Option.isNone(request)}
					loading={lookingUp}
				>
					Continue
				</Button>
			</DialogFooter>
		</Frame>
	)
}

/** Change what the drains forward. Saving re-applies the drains on Vercel at once. */
function SettingsFlow({ status, onClose }: { status: VercelIntegrationStatus; onClose: () => void }) {
	const save = useAtomSet(MapleInternalAtomClient.mutation("integrations", "vercelSettings"), {
		mode: "promiseExit",
	})
	const saved = draftOf(status)
	const [draft, setDraft] = useState<VercelDraft>(saved)
	const [confirming, setConfirming] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const projectNames = new Map(status.projects.map((project) => [project.id, project.name]))
	const patch = settingsPatch(saved, draft)
	const changed = Object.keys(patch).length > 0
	const stops = stoppedByDraft(saved, draft, projectNames)
	const problem = draftProblem(draft)

	const [apply, applying] = useAsyncAction(async () => {
		setError(null)
		const result = await save({ payload: new VercelSettingsRequest(patch), reactivityKeys: REACTIVITY })
		if (Exit.isFailure(result)) {
			setError(errorMessage(result, "Failed to update the drains."))
			return false
		}
		toastManager.add({ type: "success", title: "Drains updated on Vercel" })
		onClose()
		return true
	})

	return (
		<Frame onClose={onClose} busy={applying}>
			<Header title={`Configure ${status.team?.name ?? "Vercel"}`} />
			<DialogPanel className="flex flex-col gap-5">
				<VercelSettingsFields projects={status.projects} draft={draft} onDraft={setDraft} />
				{error !== null ? (
					<Alert size="sm" variant="crit" role="alert">
						<AlertWarningIcon size={14} />
						<AlertTitle>Vercel refused the change</AlertTitle>
						<AlertDescription className="[overflow-wrap:anywhere]">{error}</AlertDescription>
					</Alert>
				) : null}
			</DialogPanel>
			<DialogFooter>
				<FooterNote>{problem ?? "Saving updates the drains on Vercel immediately."}</FooterNote>
				<DialogClose render={<Button variant="outline" disabled={applying} />}>Cancel</DialogClose>
				<Button
					disabled={!changed || problem !== null}
					loading={applying}
					onClick={() => (stops.length > 0 ? setConfirming(true) : void apply())}
				>
					Save and apply
				</Button>
			</DialogFooter>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Forward less from Vercel?"
				description="This takes effect on Vercel as soon as you confirm."
				confirmLabel="Apply"
				onConfirm={apply}
			>
				<ul className="flex list-disc flex-col gap-1 pb-3 pl-5 text-sm">
					{stops.map((stop) => (
						<li key={stop}>{stop}</li>
					))}
				</ul>
			</ConfirmDialog>
		</Frame>
	)
}

/** A new token for the same team, keeping what the drains forward. */
function TokenFlow({ status, onClose }: { status: VercelIntegrationStatus; onClose: () => void }) {
	const connect = useAtomSet(MapleInternalAtomClient.mutation("integrations", "vercelConnect"), {
		mode: "promiseExit",
	})
	const [token, setToken] = useState("")
	const [error, setError] = useState<string | null>(null)
	const request = decodeDiscover({ token: token.trim() })
	const team = status.team

	const [submit, saving] = useAsyncAction(async () => {
		if (Option.isNone(request) || team === null) return
		setError(null)
		const result = await connect({
			payload: new VercelConnectRequest({
				token: request.value.token,
				teamId: team.id,
				...draftOf(status),
			}),
			reactivityKeys: REACTIVITY,
		})
		if (Exit.isFailure(result)) {
			setError(errorMessage(result, "Vercel didn't accept this token."))
			return
		}
		toastManager.add({ type: "success", title: "Vercel token updated" })
		onClose()
	})

	return (
		<Frame onClose={onClose} busy={saving}>
			<Header title={`New token for ${team?.name ?? "Vercel"}`} />
			<DialogPanel>
				<form
					id="vercel-rotate-form"
					onSubmit={(event) => {
						event.preventDefault()
						void submit()
					}}
				>
					<VercelTokenFields token={token} onToken={setToken} error={error} />
				</form>
			</DialogPanel>
			<DialogFooter>
				<FooterNote>
					Maple checks it can see {team?.name ?? "the team"} and re-applies the drains.
				</FooterNote>
				<DialogClose render={<Button variant="outline" disabled={saving} />}>Cancel</DialogClose>
				<Button
					type="submit"
					form="vercel-rotate-form"
					disabled={Option.isNone(request)}
					loading={saving}
				>
					Save token
				</Button>
			</DialogFooter>
		</Frame>
	)
}

/** The one place the Vercel connection is configured: connecting, its settings, a new token. */
export function VercelConfigure({
	target,
	status,
	onClose,
}: {
	target: VercelConfigureTarget
	status: VercelIntegrationStatus | null
	onClose: () => void
}) {
	if (target === "connect" || status === null || !status.connected) return <ConnectFlow onClose={onClose} />
	return target === "token" ? (
		<TokenFlow status={status} onClose={onClose} />
	) : (
		<SettingsFlow status={status} onClose={onClose} />
	)
}
