import { useState } from "react"
import { Exit, Option } from "effect"
import type { ChatConnectorId, ChatWorkspaceId } from "@maple/domain/primitives"
import type { V2ChatConnector } from "@maple/domain/http/v2"

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toastManager } from "@maple/ui/components/ui/toast"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { chatConnectorManifests } from "@maple/chat-platform/manifests"

import { ErrorState } from "@/components/common/error-state"
import { LoaderIcon } from "@/components/icons"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { getExitErrorMessage } from "@/lib/alerts/form-utils"
import { catalogEntry, chatIntegrationId, IntegrationIconPlate } from "./integration-catalog"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"

/**
 * The one card for every chat platform. Everything it renders — name, icon,
 * accent, the settings fields — comes from the connector's manifest, and
 * everything it writes goes through the generic `/v2/integrations/chat_*`
 * endpoints. There is deliberately no per-platform component, and adding one
 * would be the first step back to a card per vendor.
 */

const REACTIVITY_KEYS = ["chatIntegration"]

/**
 * A workspace's settings form: one text input per manifest field.
 *
 * The draft is seeded once per mounted instance, so the caller remounts it when
 * the stored settings change — the server normalizes what it stores (blanks
 * dropped, values trimmed), and a draft left holding what was typed would read
 * as unsaved changes forever.
 */
function WorkspaceSettings({
	fields,
	workspaceId,
	settings,
	canEdit,
	busy,
	onBusy,
}: {
	fields: ReadonlyArray<{ key: string; label: string; help: string }>
	workspaceId: ChatWorkspaceId
	settings: Readonly<Record<string, string>>
	canEdit: boolean
	/** Card-level busy marker; one write at a time across every workspace. */
	busy: string | null
	onBusy: (busy: string | null) => void
}) {
	const [draft, setDraft] = useState<Record<string, string>>(() =>
		Object.fromEntries(fields.map((field) => [field.key, settings[field.key] ?? ""])),
	)
	const update = useAtomSet(MapleApiV2AtomClient.mutation("chatIntegration", "updateWorkspace"), {
		mode: "promiseExit",
	})

	const saving = busy === workspaceId
	const disabled = !canEdit || busy !== null
	const dirty = fields.some((field) => (draft[field.key] ?? "") !== (settings[field.key] ?? ""))

	async function handleSave() {
		onBusy(workspaceId)
		const result = await update({
			params: { id: workspaceId },
			payload: { settings: draft },
			reactivityKeys: REACTIVITY_KEYS,
		})
		onBusy(null)
		toastManager.add(
			Exit.isSuccess(result)
				? { title: "Settings saved", type: "success" }
				: {
						title: getExitErrorMessage(result, "Failed to save the settings"),
						type: "error",
					},
		)
	}

	if (fields.length === 0) return null

	return (
		<div className="flex flex-col gap-3 border-t border-border/60 pt-3">
			{fields.map((field) => (
				<div key={field.key} className="flex flex-col gap-1.5">
					<Label htmlFor={`${workspaceId}-${field.key}`} className="text-xs">
						{field.label}
					</Label>
					<Input
						id={`${workspaceId}-${field.key}`}
						value={draft[field.key] ?? ""}
						disabled={disabled}
						onChange={(event) =>
							setDraft((current) => ({ ...current, [field.key]: event.target.value }))
						}
					/>
					<p className="text-[11px] text-muted-foreground">{field.help}</p>
				</div>
			))}
			<div>
				<Button size="sm" variant="outline" onClick={handleSave} disabled={disabled || !dirty}>
					{saving ? <LoaderIcon size={14} className="animate-spin" /> : null}
					Save settings
				</Button>
			</div>
		</div>
	)
}

/**
 * The caller's own chat account, linked to their own Maple user.
 *
 * Deliberately ungated: this binds the account of whoever is looking, under the roles they
 * already hold, so an admin role would gate nothing. Only connectors whose platform can say who
 * acted render it at all.
 */
function ChatIdentityRow({
	connector,
	platform,
	identity,
}: {
	connector: ChatConnectorId
	platform: string
	identity: V2ChatConnector["identity"]
}) {
	const startLink = useAtomSet(MapleApiV2AtomClient.mutation("chatIntegration", "startChatIdentityLink"), {
		mode: "promiseExit",
	})
	const unlink = useAtomSet(MapleApiV2AtomClient.mutation("chatIntegration", "deleteChatIdentity"), {
		mode: "promiseExit",
	})
	const [busy, setBusy] = useState(false)

	async function handleLink() {
		setBusy(true)
		const result = await startLink({ params: { connector }, reactivityKeys: REACTIVITY_KEYS })
		if (Exit.isSuccess(result)) {
			// Full-page redirect to the platform's consent screen, as the install does.
			window.location.href = result.value.url
			return
		}
		setBusy(false)
		toastManager.add({
			title: getExitErrorMessage(result, "Failed to start the account link"),
			type: "error",
		})
	}

	async function handleUnlink() {
		setBusy(true)
		const result = await unlink({ params: { connector }, reactivityKeys: REACTIVITY_KEYS })
		setBusy(false)
		toastManager.add(
			Exit.isSuccess(result)
				? { title: "Account unlinked", type: "success" }
				: {
						title: getExitErrorMessage(result, "Failed to unlink the account"),
						type: "error",
					},
		)
	}

	return (
		<div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card px-4 py-3">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-xs font-medium">Your {platform} account</span>
				<span className="truncate text-[11px] text-muted-foreground">
					{identity === undefined
						? `Link it so Maple knows it's you acting from ${platform}.`
						: `Linked as ${identity.display_name ?? identity.external_user_id}`}
				</span>
			</div>
			<Button
				size="sm"
				variant="outline"
				onClick={identity === undefined ? handleLink : handleUnlink}
				disabled={busy}
			>
				{busy ? <LoaderIcon size={14} className="animate-spin" /> : null}
				{identity === undefined ? "Link your account" : "Unlink"}
			</Button>
		</div>
	)
}

export function ChatIntegrationCard({ connector }: { connector: ChatConnectorId }) {
	const manifest = chatConnectorManifests.find((entry) => entry.id === connector)
	const listAtom = retainedQueryV2("chatIntegration", "connectors", {
		reactivityKeys: REACTIVITY_KEYS,
	})
	const listResult = useAtomValue(listAtom)
	const refresh = useAtomRefresh(listAtom)

	// Same gate the API applies (and always true on self-hosted, which runs as a
	// single root user). `useIsOrgAdmin` reports false until the session lands, so
	// the admin-only copy waits for a settled session; the controls stay disabled
	// meanwhile either way.
	const isAdmin = useIsOrgAdmin()
	const sessionResult = useAtomValue(retainedQuery("auth", "session", {}))
	const adminKnown = !isClerkAuthEnabled || !Result.isInitial(sessionResult)
	const showNotAdmin = adminKnown && !isAdmin

	const install = useAtomSet(MapleApiV2AtomClient.mutation("chatIntegration", "install"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiV2AtomClient.mutation("chatIntegration", "deleteWorkspace"), {
		mode: "promiseExit",
	})
	const [busy, setBusy] = useState<string | null>(null)
	const [confirmId, setConfirmId] = useState<ChatWorkspaceId | null>(null)

	// A refetch that fails must not wipe a card that already loaded — the list is
	// refetched after every save and disconnect.
	const status = Result.builder(listResult)
		.onSuccess((response) => response.data.find((entry) => entry.id === connector) ?? null)
		.orElse(() =>
			Result.isFailure(listResult)
				? Option.getOrNull(
						Option.map(
							listResult.previousSuccess,
							(previous) => previous.value.data.find((entry) => entry.id === connector) ?? null,
						),
					)
				: null,
		)

	if (manifest === undefined) return null
	// Bound once for the handlers below: a function declaration is hoisted, so
	// the narrowing above does not reach inside one.
	const platform = manifest.name

	async function handleInstall() {
		setBusy("install")
		const result = await install({ params: { connector }, reactivityKeys: REACTIVITY_KEYS })
		if (Exit.isSuccess(result)) {
			// Full-page redirect to the platform's consent screen; its callback
			// returns the browser to /integrations with the outcome.
			window.location.href = result.value.url
			return
		}
		setBusy(null)
		toastManager.add({
			title: getExitErrorMessage(result, `Failed to start the ${platform} install`),
			type: "error",
		})
	}

	async function handleDisconnect(workspaceId: ChatWorkspaceId) {
		setBusy(workspaceId)
		const result = await disconnect({
			params: { id: workspaceId },
			reactivityKeys: REACTIVITY_KEYS,
		})
		setBusy(null)
		setConfirmId(null)
		toastManager.add(
			Exit.isSuccess(result)
				? { title: "Workspace disconnected", type: "success" }
				: {
						title: getExitErrorMessage(result, "Failed to disconnect the workspace"),
						type: "error",
					},
		)
	}

	if (Result.isInitial(listResult) && status === null) {
		return (
			<div className="flex min-h-70 flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-input px-6 py-10">
				<Skeleton className="size-14 rounded-xl" />
				<Skeleton className="h-4 w-72 max-w-full" />
				<Skeleton className="h-9 w-36 rounded-md" />
			</div>
		)
	}
	if (Result.isFailure(listResult) && status === null) {
		return (
			<ErrorState
				error={listResult.cause}
				title={`Failed to load the ${manifest.name} integration`}
				onRetry={refresh}
			/>
		)
	}

	// Icon and accent come from the catalog entry the manifest already produced,
	// so the mark is one component instance rather than one per render.
	const entry = catalogEntry(chatIntegrationId(connector))
	const Icon = entry.icon
	const MonoIcon = entry.monoIcon ?? Icon
	const workspaces = status?.workspaces ?? []
	// Strictly true: a connector the API did not list is one this deployment
	// cannot install either.
	const available = status?.available === true
	const connectDisabled = !isAdmin || !available || busy !== null

	if (workspaces.length === 0) {
		return (
			<IntegrationEmpty icon={Icon} backerIcon={MonoIcon} accent={entry.accent}>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>{manifest.description}</IntegrationEmptyHint>
					<Button onClick={handleInstall} disabled={connectDisabled}>
						{busy === "install" ? (
							<LoaderIcon size={16} className="animate-spin" />
						) : (
							<MonoIcon size={16} />
						)}
						Add to {manifest.name}
					</Button>
					<IntegrationEmptyFooter>
						{!available
							? `${manifest.name} is not configured in this Maple deployment. Contact support.`
							: showNotAdmin
								? `Only organization admins can connect ${manifest.name}.`
								: `You'll approve the install in ${manifest.name}.`}
					</IntegrationEmptyFooter>
				</IntegrationEmptyCard>
			</IntegrationEmpty>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			{workspaces.map((workspace) => (
				<div
					key={workspace.id}
					className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4"
				>
					<IntegrationIconPlate icon={Icon} accent={entry.accent} />
					<div className="flex flex-1 flex-col gap-2">
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">{workspace.name}</h3>
							<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
								Connected
							</span>
						</div>
						<p className="text-xs text-muted-foreground">
							Linked to your organization, for everyone in this workspace — no {manifest.name}{" "}
							account is tied to an individual Maple user.
						</p>
						<div className="text-[11px] text-muted-foreground">
							Connected {formatRelativeTime(workspace.created_at)}
						</div>
						{/* Keyed by the stored settings so a save reseeds the form from what
						    the server actually kept. */}
						<WorkspaceSettings
							key={JSON.stringify(workspace.settings)}
							fields={manifest.settingsFields}
							workspaceId={workspace.id}
							settings={workspace.settings}
							canEdit={isAdmin}
							busy={busy}
							onBusy={setBusy}
						/>
						<div>
							<Button
								size="sm"
								variant="outline"
								onClick={() => setConfirmId(workspace.id)}
								disabled={!isAdmin || busy !== null}
							>
								Disconnect
							</Button>
						</div>
					</div>
				</div>
			))}
			{status?.supports_identity === true ? (
				<ChatIdentityRow connector={connector} platform={platform} identity={status.identity} />
			) : null}
			<div>
				<Button size="sm" variant="outline" onClick={handleInstall} disabled={connectDisabled}>
					{busy === "install" ? <LoaderIcon size={14} className="animate-spin" /> : null}
					Add another workspace
				</Button>
			</div>
			{showNotAdmin ? (
				<p className="text-[11px] text-muted-foreground">
					Only organization admins can change or disconnect {manifest.name} workspaces.
				</p>
			) : null}

			<AlertDialog open={confirmId !== null} onOpenChange={(open) => !open && setConfirmId(null)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Disconnect workspace</AlertDialogTitle>
						<AlertDialogDescription>
							This workspace is unlinked from your organization immediately. Removing the bot
							from the workspace itself is done in {manifest.name}.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => confirmId !== null && handleDisconnect(confirmId)}
							disabled={busy !== null}
						>
							{busy === confirmId ? <LoaderIcon size={14} className="animate-spin" /> : null}
							Disconnect
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
