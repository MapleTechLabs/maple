import { useMemo } from "react"
import type { DashboardId, DashboardVersionId } from "@maple/domain/http"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Result } from "@/lib/effect-atom"
import { ErrorState } from "@/components/common/error-state"
import { HistoryIcon, XmarkIcon } from "@/components/icons"
import { useDashboardVersions } from "./use-dashboard-history"
import { VersionListItem } from "./version-list-item"
import type { PreviewedVersion } from "@/atoms/dashboard-history-atoms"

interface DashboardHistoryPanelProps {
	dashboardId: DashboardId
	previewed: PreviewedVersion | null
	onPreview: (versionId: DashboardVersionId) => void
	onClose: () => void
}

export function DashboardHistoryPanel({
	dashboardId,
	previewed,
	onPreview,
	onClose,
}: DashboardHistoryPanelProps) {
	const result = useDashboardVersions(dashboardId)

	const versions = useMemo(() => (Result.isSuccess(result) ? [...result.value.data] : []), [result])

	const isLoading = !Result.isSuccess(result) && !Result.isFailure(result)
	const isError = Result.isFailure(result)
	const latestVersionId = versions[0]?.id ?? null

	return (
		<aside className="flex h-full w-80 shrink-0 flex-col border-l bg-background">
			<div className="flex items-center gap-2 border-b px-4 py-3">
				<HistoryIcon className="size-4" />
				<h2 className="text-sm font-medium tracking-tight">History</h2>
				<span className="ml-1 font-mono text-3xs text-muted-foreground">{versions.length}</span>
				<IconButton
					size="icon-xs"
					label="Close history panel"
					onClick={onClose}
					className="ml-auto text-muted-foreground hover:text-foreground"
				>
					<XmarkIcon size={14} />
				</IconButton>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto">
				{isLoading && (
					<div role="status" aria-label="Loading history" className="flex flex-col gap-4 px-4 py-4">
						{[0, 1, 2, 3].map((i) => (
							<div key={i} className="flex flex-col gap-1.5">
								<Skeleton className="h-3 w-32" />
								<Skeleton className="h-2.5 w-48 opacity-60" />
							</div>
						))}
					</div>
				)}

				{Result.isFailure(result) && (
					<ErrorState
						variant="inline"
						error={result.cause}
						title="Failed to load history"
						className="px-4"
					/>
				)}

				{!isLoading && !isError && versions.length === 0 && (
					<Empty className="gap-0 px-4 py-12 md:py-12">
						<EmptyHeader>
							<EmptyMedia className="mb-3 size-9 rounded-full bg-muted">
								<HistoryIcon size={16} className="text-muted-foreground" />
							</EmptyMedia>
							<EmptyTitle className="text-xs font-medium">No history yet</EmptyTitle>
							<EmptyDescription className="text-2xs">
								Each save is captured here so you can revisit or restore.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}

				{!isLoading && !isError && versions.length > 0 && (
					<ol className="relative">
						{/* Continuous timeline rail. Sits behind the markers — uses the
                same color as the panel border for a quiet ledger feel. */}
						<span aria-hidden className="absolute left-4 top-3 bottom-3 w-px bg-border" />
						{versions.map((version) => (
							<VersionListItem
								key={version.id}
								version={version}
								isPreviewing={previewed?.versionId === version.id}
								isCurrent={previewed === null && version.id === latestVersionId}
								onPreview={() => onPreview(version.id)}
							/>
						))}
					</ol>
				)}
			</div>
		</aside>
	)
}
