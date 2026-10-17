import * as React from "react"
import { useBlocker } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { cn } from "@maple/ui/lib/utils"

import type { SettingsWidth } from "@/components/settings/settings-section"

/**
 * Asks before leaving a page with unsaved edits: in-app navigation (including a settings tab
 * switch) gets a confirm dialog, a reload or tab close gets the browser's own prompt.
 */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
	const { proceed, reset, status } = useBlocker({
		shouldBlockFn: () => when,
		enableBeforeUnload: () => when,
		withResolver: true,
	})
	return (
		<ConfirmDialog
			open={status === "blocked"}
			onOpenChange={(open) => {
				if (!open) reset?.()
			}}
			title="Discard unsaved changes?"
			description="You have changes on this page that are not saved yet."
			cancelLabel="Keep editing"
			confirmLabel="Discard changes"
			onConfirm={() => proceed?.()}
		/>
	)
}

/**
 * The bar pinned to the bottom of a settings tab while it has unsaved edits. Renders nothing
 * when clean, and guards navigation while dirty, so a tab only needs this one element.
 */
export function SettingsSaveBar({
	dirty,
	pending = false,
	context,
	onDiscard,
	onSave,
	saveLabel = "Save",
	saveDisabled = false,
	width = "standard",
	className,
}: {
	dirty: boolean
	/** Save in flight: the save button spins and discard is disabled. */
	pending?: boolean
	/** Optional detail after "Unsaved changes", e.g. "2 rules changed". */
	context?: React.ReactNode
	onDiscard: () => void
	onSave: () => void
	saveLabel?: React.ReactNode
	/** Keeps save disabled while the draft is invalid. */
	saveDisabled?: boolean
	/** Match the tab's `SettingsSections` width. */
	width?: SettingsWidth
	className?: string
}) {
	const visible = dirty || pending
	return (
		<>
			{/* Stays armed while a save is in flight: a failed save must not lose the edits. */}
			<UnsavedChangesGuard when={dirty} />
			{visible ? (
				<section
					aria-label="Unsaved changes"
					className={cn(
						"sticky bottom-4 z-10 mt-6 flex w-full items-center justify-between gap-4 rounded-lg border bg-popover py-2 pr-2 pl-4 shadow-lg",
						width === "standard" && "max-w-3xl",
						className,
					)}
				>
					<div className="flex min-w-0 items-center gap-2 text-sm">
						<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
						<span className="shrink-0 text-foreground">Unsaved changes</span>
						{context ? <span className="truncate text-muted-foreground">{context}</span> : null}
					</div>
					<div className="flex shrink-0 items-center gap-1.5">
						<Button variant="ghost" size="sm" disabled={pending} onClick={onDiscard}>
							Discard
						</Button>
						<Button size="sm" loading={pending} disabled={saveDisabled} onClick={onSave}>
							{saveLabel}
						</Button>
					</div>
				</section>
			) : null}
		</>
	)
}
