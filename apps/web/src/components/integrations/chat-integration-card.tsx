import { useState } from "react"
import { Exit } from "effect"

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
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
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

/** A workspace's settings form: one text input per manifest field. */
function WorkspaceSettings({
	fields,
	workspaceId,
	settings,
	disabled,
	onSaved,
}: {
	fields: ReadonlyArray<{ key: string; label: string; help: string }>
	workspaceId: string
	settings: Readonly<Record<string, string>>
	disabled: boolean
	onSaved: () => void
}) {
	const [draft, setDraft] = useState<Record<string, string>>(() =>
		Object.fromEntries(fields.map((field) => [field.key, settings[field.key] ?? ""])),
	)
	const [saving, setSaving] = useState(false)
	const update = useAtomSet(MapleApiV2AtomClient.mutation("chatIntegration", "updateWorkspace"), {
		mode: "promiseExit",
	})

	const dirty = fields.some((field) => (draft[field.key] ?? "") !== (settings[field.key] ?? ""))

	async function handleSave() {
		setSaving(true)
		const result = await update({
			params: { id: workspaceId },
			payload: { settings: draft },
			reactivityKeys: REACTIVITY_KEYS,
		})
		setSaving(false)
		if (Exit.isSuccess(result)) {
			onSaved()
			toastManager.add({ title: "Settings saved", type: "success" })
		} else {
			toastManager.add({
				title: getExitErrorMessage(result, "Failed to save the settings"),
				type: "error",
			})
		}
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
						disabled={disabled || saving}
						onChange={(event) =>
							setDraft((current) => ({ ...current, [field.key]: event.target.value }))
						}
					/>
					<p className="text-[11px] text-muted-foreground">{field.help}</p>
				</div>
			))}
			<div>
				<Button
					size="sm"
					variant="outline"
					onClick={handleSave}
					disabled={disabled || saving || !dirty}
				>
					{saving ? <LoaderIcon size={14} className="animate-spin" /> : null}
					Save settings
				</Button>
			</div>
		</div>
	)
}

export function ChatIntegrationCard({ connector }: { connector: string }) {
	const manifest = chatConnectorManifests.find((entry) => entry.id === connector)
	const listAtom = retainedQueryV2("chatIntegration", "connectors", {
		reactivityKeys: REACTIVITY_KEYS,
	})
	const listResult = useAtomValue(listAtom)
	const refresh = useAtomRefresh(listAtom)
	const isAdmin = useIsOrgAdmin()

	const install = useAtomSet(MapleApiV2AtomClient.mutation("chatIntegration", "install"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiV2AtomClient.mutation("chatIntegration", "deleteWorkspace"), {
		mode: "promiseExit",
	})
	const [busy, setBusy] = useState<string | null>(null)
	const [confirmId, setConfirmId] = useState<string | null>(null)

	const status = Result.builder(listResult)
		.onSuccess((response) => response.data.find((entry) => entry.id === connector) ?? null)
		.orElse(() => null)

	if (manifest === undefined) return null

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
			title: getExitErrorMessage(result, `Failed to start the ${manifest?.name} install`),
			type: "error",
		})
	}

	async function handleDisconnect(workspaceId: string) {
		setBusy(workspaceId)
		const result = await disconnect({
			params: { id: workspaceId },
			reactivityKeys: REACTIVITY_KEYS,
		})
		setBusy(null)
		setConfirmId(null)
		if (Exit.isSuccess(result)) {
			refresh()
			toastManager.add({ title: "Workspace disconnected", type: "success" })
		} else {
			toastManager.add({
				title: getExitErrorMessage(result, "Failed to disconnect the workspace"),
				type: "error",
			})
		}
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
	const workspaces = status?.workspaces ?? []
	const available = status?.available !== false
	const connectDisabled = !isAdmin || !available || busy !== null

	if (workspaces.length === 0) {
		return (
			<IntegrationEmpty icon={Icon} accent={entry.accent}>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>{manifest.description}</IntegrationEmptyHint>
					<Button onClick={handleInstall} disabled={connectDisabled}>
						{busy === "install" ? (
							<LoaderIcon size={16} className="animate-spin" />
						) : (
							<Icon size={16} />
						)}
						Add to {manifest.name}
					</Button>
					<IntegrationEmptyFooter>
						{!available
							? `${manifest.name} is not configured in this Maple deployment. Contact support.`
							: !isAdmin
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
							The Maple bot answers anyone in this workspace on your organization&apos;s behalf.
							Changes it proposes are approved in {manifest.name}.
						</p>
						<div className="text-[11px] text-muted-foreground">
							Connected {formatRelativeTime(workspace.created_at)}
						</div>
						<WorkspaceSettings
							fields={manifest.settingsFields}
							workspaceId={workspace.id}
							settings={workspace.settings}
							disabled={!isAdmin || busy !== null}
							onSaved={refresh}
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
			<div>
				<Button size="sm" variant="outline" onClick={handleInstall} disabled={connectDisabled}>
					{busy === "install" ? <LoaderIcon size={14} className="animate-spin" /> : null}
					Add another workspace
				</Button>
			</div>

			<AlertDialog open={confirmId !== null} onOpenChange={(open) => !open && setConfirmId(null)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Disconnect workspace</AlertDialogTitle>
						<AlertDialogDescription>
							The Maple bot stops answering in this workspace immediately. Removing the bot from
							the workspace itself is done in {manifest.name}.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => confirmId !== null && handleDisconnect(confirmId)}
							disabled={busy !== null}
						>
							{busy !== null && busy !== "install" ? (
								<LoaderIcon size={14} className="animate-spin" />
							) : null}
							Disconnect
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
