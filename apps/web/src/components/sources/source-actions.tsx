import type { V2Source } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { useState } from "react"
import { ArrowPathIcon, MediaPauseIcon, MediaPlayIcon, TrashIcon } from "@/components/icons"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { useAtomRefresh, useAtomSet } from "@/lib/effect-atom"
import { toastExit } from "@/lib/error-toast"
import { sourcesListAtom } from "@/lib/services/atoms/sources-atoms"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import type { RevealedToken } from "./shared"

const HOUR_MS = 3_600_000

export const PAUSE_CHOICES = [
	{ label: "For 1 hour", hours: 1 },
	{ label: "For 24 hours", hours: 24 },
	{ label: "Until resumed", hours: null },
] as const

function useSourceMutations() {
	return {
		pause: useAtomSet(MapleApiV2AtomClient.mutation("sources", "pause"), { mode: "promiseExit" }),
		resume: useAtomSet(MapleApiV2AtomClient.mutation("sources", "resume"), { mode: "promiseExit" }),
		roll: useAtomSet(MapleApiV2AtomClient.mutation("sources", "roll"), { mode: "promiseExit" }),
		remove: useAtomSet(MapleApiV2AtomClient.mutation("sources", "delete"), { mode: "promiseExit" }),
	}
}

/** Pause, resume, roll and delete. Not offered for the default source. */
export function SourceActions({
	source,
	onRevealed,
	onDeleted,
}: {
	source: V2Source
	onRevealed: (revealed: RevealedToken) => void
	onDeleted: () => void
}) {
	const refresh = useAtomRefresh(sourcesListAtom)
	const mutations = useSourceMutations()
	const [rollOpen, setRollOpen] = useState(false)
	const [deleteOpen, setDeleteOpen] = useState(false)
	const id = source.id

	const [pause, pausing] = useAsyncAction(async (hours: number | null) => {
		const until = hours === null ? null : new Date(Date.now() + hours * HOUR_MS).toISOString()
		const result = await mutations.pause({ params: { id }, payload: { until } })
		if (
			toastExit(result, {
				success: "Source paused. Takes effect within a minute.",
				error: "Failed to pause source",
			})
		)
			refresh()
	})
	const [resume, resuming] = useAsyncAction(async () => {
		const result = await mutations.resume({ params: { id } })
		if (
			toastExit(result, {
				success: "Source resumed. Takes effect within a minute.",
				error: "Failed to resume source",
			})
		)
			refresh()
	})
	const [roll, rolling] = useAsyncAction(async () => {
		const result = await mutations.roll({ params: { id } })
		setRollOpen(false)
		if (!toastExit(result, { error: "Failed to roll token" })) return
		refresh()
		if (result._tag === "Success") onRevealed({ sourceId: id, secret: result.value.secret, rolled: true })
	})
	async function remove() {
		const ok = toastExit(await mutations.remove({ params: { id } }), {
			success: "Source deleted",
			error: "Failed to delete source",
		})
		if (ok) {
			refresh()
			onDeleted()
		}
		return ok
	}

	return (
		<>
			{source.status === "paused" ? (
				<Button variant="outline" size="sm" onClick={() => void resume()} loading={resuming}>
					<MediaPlayIcon data-icon="inline-start" />
					Resume
				</Button>
			) : (
				<PauseMenu
					disabled={source.status === "expired"}
					pending={pausing}
					onPause={(hours) => void pause(hours)}
				/>
			)}
			<Button variant="outline" size="sm" onClick={() => setRollOpen(true)}>
				<ArrowPathIcon data-icon="inline-start" />
				Roll token
			</Button>
			<Button
				variant="ghost"
				size="sm"
				className="text-destructive"
				onClick={() => setDeleteOpen(true)}
			>
				<TrashIcon data-icon="inline-start" />
				Delete
			</Button>
			<ConfirmDialog
				open={rollOpen}
				onOpenChange={setRollOpen}
				title="Roll this source's token?"
				description={
					<>
						<span className="text-foreground font-medium">{source.name}</span> gets a new token
						and keeps its settings. Senders using the old token are rejected within a minute.
					</>
				}
				confirmLabel="Roll token"
				onConfirm={() => void roll()}
				pending={rolling}
			/>
			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				title="Delete source?"
				description={
					<>
						Senders using <span className="text-foreground font-medium">{source.name}</span> are
						rejected within a minute. This cannot be undone.
					</>
				}
				confirmLabel="Delete"
				onConfirm={remove}
			/>
		</>
	)
}

function PauseMenu({
	disabled,
	pending,
	onPause,
}: {
	disabled: boolean
	pending: boolean
	onPause: (hours: number | null) => void
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Button variant="outline" size="sm" loading={pending} disabled={disabled} />}
			>
				<MediaPauseIcon data-icon="inline-start" />
				Pause
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-72">
				<div className="space-y-1 px-2 pt-1.5 pb-2">
					<p className="text-xs font-medium">Pause ingestion</p>
					<p className="text-muted-foreground text-xs leading-relaxed">
						Senders keep getting 200 OK. Data is dropped, not stored or billed.
					</p>
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					{PAUSE_CHOICES.map((choice) => (
						<DropdownMenuItem key={choice.label} onClick={() => onPause(choice.hours)}>
							{choice.label}
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
