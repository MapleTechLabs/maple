/**
 * Share a dashboard, or one chart on it.
 *
 * Two independent things live here, and the dialog keeps them visibly separate
 * because their consequences differ: a board link is for people, a chart link
 * is usually for an embed in a page the org does not control.
 *
 * Mutations go through `MapleApiV2AtomClient` rather than the TanStack DB
 * optimistic path used elsewhere in the builder. The shares table is not
 * Electric-synced — deliberately, so share metadata is not pushed into every
 * org member's shape stream — so there is no txid to await and `awaitTxId`
 * would hang forever.
 */
import { useMemo, useState, type ReactNode } from "react"
import { Exit } from "effect"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import {
	ArrowRotateClockwiseIcon,
	CircleWarningIcon,
	GlobeIcon,
	LockIcon,
	ShieldIcon,
} from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { RadioGroup, RadioGroupItem } from "@maple/ui/components/ui/radio-group"
import { cn } from "@maple/ui/lib/utils"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { displayError } from "@/lib/error-messages"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { SHAREABLE_WIDGET_KINDS, unsupportedShareWidgets } from "./share-support"
import {
	asDashboardId,
	dashboardSharesAtom,
	dashboardSharesReactivityKey,
	shareUrl,
	type ShareMode,
	type ShareRecord,
} from "./dashboard-shares"
import type { Dashboard } from "@/components/dashboard-builder/types"

export function ShareDashboardDialog({
	dashboard,
	open,
	onOpenChange,
}: {
	dashboard: Dashboard
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const listAtom = useMemo(() => dashboardSharesAtom(dashboard.id), [dashboard.id])
	const listResult = useAtomValue(listAtom)
	const refreshList = useAtomRefresh(listAtom)

	const upsert = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "upsertShare"), {
		mode: "promiseExit",
	})
	const rotate = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "rotateShare"), {
		mode: "promiseExit",
	})
	const revoke = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "revokeShare"), {
		mode: "promiseExit",
	})

	const shares = useMemo<ReadonlyArray<ShareRecord>>(
		() => (Result.isSuccess(listResult) ? listResult.value : []),
		[listResult],
	)
	const boardShare = useMemo(() => shares.find((share) => share.widgetId === undefined), [shares])

	const [error, setError] = useState<string | null>(null)

	/*
	 * The picked mode is held locally until the server confirms it, because the
	 * round-trip is long enough to see: the dot used to move ~100ms after the
	 * click, which reads as the dialog stuttering rather than responding. Server
	 * state stays the source of truth — this only covers the gap, and a failed
	 * mutation drops it so the radio falls back to what is actually stored.
	 */
	const serverMode: ShareMode | "off" = boardShare?.mode ?? "off"
	const [pendingMode, setPendingMode] = useState<ShareMode | "off" | null>(null)
	if (pendingMode !== null && pendingMode === serverMode) setPendingMode(null)

	const unsupported = useMemo(() => unsupportedShareWidgets(dashboard.widgets), [dashboard.widgets])

	/*
	 * Nothing in the dialog uses `disabled` to keep mutations from stacking —
	 * disabling a control mid-flight dims it for the length of the round-trip, and
	 * every pick or replace flashed. The guard lives here instead, so the
	 * protection is centralised and no control has to change how it looks to get it.
	 */
	const [runAction, busy] = useAsyncAction(async (action: () => Promise<Exit.Exit<unknown, unknown>>) => {
		setError(null)
		const result = await action()
		if (Exit.isFailure(result)) {
			setError(displayError(result).message)
			setPendingMode(null)
			return
		}
		refreshList()
	})
	const run = (action: () => Promise<Exit.Exit<unknown, unknown>>) =>
		busy ? Promise.resolve() : runAction(action)

	/*
	 * None of these keep the token: the refreshed list carries it, because storage
	 * holds an encrypted copy the server can read back. There is no shown-once
	 * value left to stash, and nothing here can lose one.
	 */
	const share = (mode: ShareMode) =>
		run(() =>
			upsert({
				params: { id: asDashboardId(dashboard.id) },
				payload: { mode },
				reactivityKeys: [dashboardSharesReactivityKey(dashboard.id)],
			}),
		)

	const regenerate = () =>
		run(() =>
			rotate({
				params: { id: asDashboardId(dashboard.id) },
				reactivityKeys: [dashboardSharesReactivityKey(dashboard.id)],
			}),
		)

	const stopSharing = () =>
		run(() =>
			revoke({
				params: { id: asDashboardId(dashboard.id) },
				reactivityKeys: [dashboardSharesReactivityKey(dashboard.id)],
			}),
		)

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Share dashboard</DialogTitle>
					<DialogDescription>
						Anyone you share with sees this dashboard's data, but cannot edit it.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4">
					{/* One bordered, divided group rather than three floating cards: this is a
					    single choice, and the icons read left-to-right as a ladder of exposure. */}
					<RadioGroup
						value={pendingMode ?? serverMode}
						onValueChange={(value) => {
							// Checked before the optimistic move, so a pick `run` will refuse
							// never lands on screen.
							if (busy) return
							setPendingMode(value as ShareMode | "off")
							if (value === "off") void stopSharing()
							else void share(value as ShareMode)
						}}
						className="gap-0 divide-y divide-border overflow-hidden rounded-md border"
					>
						<ShareOption
							value="off"
							icon={LockIcon}
							title="Not shared"
							body="Only members of this organization with access to Maple can see it."
						/>
						<ShareOption
							value="org"
							icon={ShieldIcon}
							title="Anyone in this organization"
							body="Signed-in members of this organization can open the link."
						/>
						<ShareOption
							value="public"
							icon={GlobeIcon}
							title="Anyone with the link"
							body="No sign-in required. Anyone who has the link can view this dashboard and its data."
						/>
					</RadioGroup>

					{boardShare ? (
						<ShareLinkRow
							url={shareUrl(boardShare.token)}
							onReplace={() => void regenerate()}
							replaceWarning="Anyone using the current link loses access to this dashboard. Chart embeds keep working."
						/>
					) : null}

					{unsupported.length > 0 && boardShare ? (
						<NoticeRow>
							{unsupported.length === 1
								? "1 widget won't render for viewers"
								: `${unsupported.length} widgets won't render for viewers`}
							: {unsupported.map((widget) => widget.title).join(", ")}. Shared views support{" "}
							{SHAREABLE_WIDGET_KINDS}.
						</NoticeRow>
					) : null}

					{error ? <NoticeRow tone="error">{error}</NoticeRow> : null}
				</DialogPanel>

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Done</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

/**
 * The whole row is the hit target. The radio nests *inside* the `<label>` rather
 * than pairing with `htmlFor`: Base UI renders it as a `<button>`, and label-for-
 * button forwarding is inconsistent across browsers where implicit association is
 * not. Selection is styled off `:has([data-checked])` because Base UI puts the
 * state on the radio, not on any wrapper we own.
 */
function ShareOption({
	value,
	icon: Icon,
	title,
	body,
}: {
	value: string
	icon: typeof LockIcon
	title: string
	body: string
}) {
	return (
		<label
			htmlFor={`share-${value}`}
			className="group flex cursor-pointer items-start gap-3 px-3.5 py-3 transition-colors hover:bg-accent/40 has-[[data-checked]]:bg-accent/64"
		>
			<Icon
				size={15}
				className="mt-0.5 shrink-0 text-muted-foreground transition-colors group-has-[[data-checked]]:text-primary"
			/>
			<div className="min-w-0 flex-1 space-y-0.5">
				<div className="font-medium text-sm leading-5">{title}</div>
				<p className="text-muted-foreground text-xs leading-relaxed">{body}</p>
			</div>
			<RadioGroupItem value={value} id={`share-${value}`} className="mt-0.5 shrink-0" />
		</label>
	)
}

function NoticeRow({ tone = "muted", children }: { tone?: "muted" | "error"; children: ReactNode }) {
	return (
		<div
			className={cn(
				"flex items-start gap-2 text-xs leading-relaxed",
				tone === "error" ? TONE_TEXT.crit : "text-muted-foreground",
			)}
		>
			<CircleWarningIcon size={13} className="mt-0.5 shrink-0" />
			<p className="min-w-0">{children}</p>
		</div>
	)
}

/**
 * Replacing kills the current link for good: every copy of it already handed
 * out, every embed on someone else's page. So it asks first.
 */
export function ShareLinkRow({
	url,
	onReplace,
	replaceWarning,
}: {
	url: string
	onReplace: () => void
	/** What stops working when the link is replaced, shown before confirming. */
	replaceWarning: string
}) {
	const [confirmingReplace, setConfirmingReplace] = useState(false)

	return (
		<div className="flex items-center gap-2">
			<div className="min-w-0 flex-1">
				<CopyableField value={url} copyLabel="Share link" />
			</div>
			<Button size="sm" variant="outline" onClick={() => setConfirmingReplace(true)}>
				<ArrowRotateClockwiseIcon />
				Replace
			</Button>
			<ConfirmDialog
				open={confirmingReplace}
				onOpenChange={setConfirmingReplace}
				title="Replace this link?"
				description={`${replaceWarning} This can't be undone.`}
				confirmLabel="Replace link"
				onConfirm={() => {
					setConfirmingReplace(false)
					onReplace()
				}}
			/>
		</div>
	)
}
