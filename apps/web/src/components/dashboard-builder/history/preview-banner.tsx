import { useState } from "react"
import { Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import type { DashboardId } from "@maple/domain/http"
import { ArrowPathIcon, HistoryIcon } from "@/components/icons"
import { RelativeTime } from "@/components/common/relative-time"
import { buildRestorePayload, useRestoreDashboardVersion } from "./use-dashboard-history"
import type { PreviewedVersion } from "@/atoms/dashboard-history-atoms"
import { useDashboardMutationSync } from "@/hooks/use-dashboard-store"

interface PreviewBannerProps {
	dashboardId: DashboardId
	preview: PreviewedVersion
	onCancel: () => void
	onRestored: () => void
}

export function PreviewBanner({ dashboardId, preview, onCancel, onRestored }: PreviewBannerProps) {
	const [confirmOpen, setConfirmOpen] = useState(false)
	const restore = useRestoreDashboardVersion()
	const { prepareForMutation, reconcileTxid } = useDashboardMutationSync()

	// Resolves false on failure so the confirm dialog stays open for a retry.
	const performRestore = async () => {
		prepareForMutation()
		const result = await restore(buildRestorePayload(dashboardId, preview.versionId) as never)
		if (Exit.isSuccess(result)) {
			void reconcileTxid(result.value.txid)
			toastManager.add({ title: `Restored from v${preview.versionNumber}`, type: "success" })
			onRestored()
			return true
		}
		toastManager.add({ title: "Restore failed", type: "error" })
		return false
	}

	return (
		<>
			<div className="mb-4 flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
				<HistoryIcon className="size-4 shrink-0 text-primary" />
				<div className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[11px] text-foreground/80">
					<span className="font-semibold text-primary">PREVIEW</span>
					<span aria-hidden className="opacity-50">
						·
					</span>
					<span>v{preview.versionNumber}</span>
					<span aria-hidden className="opacity-50">
						·
					</span>
					<RelativeTime value={preview.createdAt} className="truncate" />
				</div>
				<div className="flex items-center gap-1.5">
					<Button variant="ghost" size="sm" onClick={onCancel}>
						Cancel
					</Button>
					<Button variant="default" size="sm" onClick={() => setConfirmOpen(true)}>
						<ArrowPathIcon size={14} data-icon="inline-start" />
						Restore this version
					</Button>
				</div>
			</div>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				tone="default"
				icon={null}
				title={`Restore version v${preview.versionNumber}?`}
				description="The current dashboard will be replaced with this version. The current state will be saved as a new history entry, so this is undoable."
				confirmLabel="Restore"
				onConfirm={performRestore}
			/>
		</>
	)
}
