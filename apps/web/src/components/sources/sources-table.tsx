import type { V2Source } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { Link, useNavigate } from "@tanstack/react-router"
import { ErrorState } from "@/components/common/error-state"
import { ChevronRightIcon, ConnectionIcon, PlusIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { sourcesListAtom } from "@/lib/services/atoms/sources-atoms"
import { PlatformTile, platformMeta } from "./platforms"
import { toPublicSourceId } from "./shared"
import { SourceStatusBadge, sourceStatus } from "./source-status"

// The whole row opens on click; the name is the real link for keyboards and screen readers.
const nameLinkClass = "truncate text-sm font-medium outline-none hover:underline focus-visible:underline"

/** Default source first, then the API's order (newest first). */
export const orderSources = (sources: ReadonlyArray<V2Source>): ReadonlyArray<V2Source> => [
	...sources.filter((source) => source.is_default),
	...sources.filter((source) => !source.is_default),
]

function SourceRow({ source, now }: { source: V2Source; now: number }) {
	const navigate = useNavigate()
	const sourceId = toPublicSourceId(source.id)
	return (
		<TableRow
			className="cursor-pointer"
			onClick={() => navigate({ to: "/sources/$sourceId", params: { sourceId } })}
		>
			<TableCell>
				<div className="flex min-w-0 items-center gap-3">
					<PlatformTile platform={source.platform} size="sm" />
					<div className="flex min-w-0 flex-col gap-0.5">
						<Link
							to="/sources/$sourceId"
							params={{ sourceId }}
							className={nameLinkClass}
							onClick={(event) => event.stopPropagation()}
						>
							{source.name}
						</Link>
						<span className="text-muted-foreground truncate text-xs">
							{platformMeta(source.platform).label}
							{source.is_default ? " · Default" : ""}
						</span>
					</div>
				</div>
			</TableCell>
			<TableCell>
				<SourceStatusBadge value={sourceStatus(source)} now={now} showTime={false} />
			</TableCell>
			<TableCell className="text-muted-foreground hidden sm:table-cell">
				{source.health.last_data_at === null
					? "Never"
					: formatRelativeTime(source.health.last_data_at, now)}
			</TableCell>
			<TableCell className="text-muted-foreground hidden truncate font-mono text-xs sm:table-cell">
				{source.key_prefix === null
					? source.is_default
						? "Org ingest keys"
						: "-"
					: `${source.key_prefix}…`}
			</TableCell>
			<TableCell>
				<ChevronRightIcon size={14} className="text-muted-foreground" />
			</TableCell>
		</TableRow>
	)
}

export function SourcesTable() {
	const listResult = useAtomValue(sourcesListAtom)
	const refresh = useAtomRefresh(sourcesListAtom)
	const now = Date.now()

	if (Result.isInitial(listResult)) {
		return <Skeleton className="h-48 w-full" />
	}
	if (!Result.isSuccess(listResult)) {
		return <ErrorState error={listResult.cause} title="Couldn't load sources" onRetry={() => refresh()} />
	}
	const sources = orderSources(listResult.value.data)
	const added = sources.filter((source) => !source.is_default)

	return (
		<div className="flex flex-col gap-4">
			<Table variant="card" className="table-fixed">
				<TableHeader>
					<TableRow>
						<TableHead>Source</TableHead>
						<TableHead className="w-36 sm:w-48">Status</TableHead>
						<TableHead className="hidden w-28 sm:table-cell">Last data</TableHead>
						<TableHead className="hidden w-44 sm:table-cell">Token</TableHead>
						<TableHead className="w-10" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{sources.map((source) => (
						<SourceRow key={source.id} source={source} now={now} />
					))}
				</TableBody>
			</Table>
			{added.length === 0 && <SourcesEmptyState />}
		</div>
	)
}

function SourcesEmptyState() {
	return (
		<Empty className="py-8">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ConnectionIcon size={16} />
				</EmptyMedia>
				<EmptyTitle>Connect your first source</EmptyTitle>
				<EmptyDescription>
					Give each SDK, cluster or host its own source to see what it sends, cap its rate, or pause
					it on its own.
				</EmptyDescription>
			</EmptyHeader>
			<Button size="sm" render={<Link to="/sources/new" />}>
				<PlusIcon data-icon="inline-start" />
				Connect source
			</Button>
		</Empty>
	)
}
