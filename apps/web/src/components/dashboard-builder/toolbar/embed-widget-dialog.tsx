/**
 * Embed one chart: its public link, plus the URL options an embed can carry.
 *
 * Mounted only while open, and mounting is what mints the chart's public share,
 * so the link is ready by the time anyone reads it. The menu item that opens it
 * requires a public board, which means the share list has already loaded. The share list is the same atom the board
 * dialog reads, so a link minted here shows up there and vice versa.
 */
import { useMemo, useState } from "react"
import { useMountEffect } from "@maple/ui/hooks/use-mount-effect"
import { Exit } from "effect"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { Button } from "@maple/ui/components/ui/button"
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
import { ALL_VALUE } from "@maple/query-engine"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { displayError } from "@/lib/error-messages"
import { REFRESH_INTERVAL_OPTIONS } from "@/lib/dashboard-controls/search-params"
import { useDashboardVariablesOptional } from "@/components/dashboard-builder/dashboard-variables-context"
import {
	asDashboardId,
	dashboardSharesAtom,
	dashboardSharesReactivityKey,
	embedUrl,
	type ShareRecord,
} from "./dashboard-shares"
import { ShareLinkRow } from "./share-dashboard-dialog"

/** `YYYY-MM-DD HH:MM:SS` in UTC — the only shape the share API accepts. */
const warehouseDateTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

export function EmbedWidgetDialog({
	dashboardId,
	widgetId,
	open,
	onOpenChange,
}: {
	dashboardId: string
	widgetId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const sharesAtom = useMemo(() => dashboardSharesAtom(dashboardId), [dashboardId])
	const sharesResult = useAtomValue(sharesAtom)
	const refreshShares = useAtomRefresh(sharesAtom)
	const upsert = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "upsertWidgetShare"), {
		mode: "promiseExit",
	})
	const rotate = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "rotateWidgetShare"), {
		mode: "promiseExit",
	})
	const [error, setError] = useState<string | null>(null)

	const share = Result.isSuccess(sharesResult)
		? (sharesResult.value as ReadonlyArray<ShareRecord>).find(
				(candidate) => candidate.widgetId === widgetId && candidate.mode === "public",
			)
		: undefined

	const request = {
		params: { id: asDashboardId(dashboardId), widget_id: widgetId },
		reactivityKeys: [dashboardSharesReactivityKey(dashboardId)],
	}

	const run = async (action: () => Promise<Exit.Exit<unknown, unknown>>) => {
		setError(null)
		const result = await action()
		if (Exit.isFailure(result)) setError(displayError(result).message)
		else refreshShares()
	}

	useMountEffect(() => {
		if (share === undefined) void run(() => upsert({ ...request, payload: { mode: "public" } }))
	})

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Embed chart</DialogTitle>
					<DialogDescription>
						Anyone with the link can view this chart. It stops working while the dashboard is not
						public.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4">
					{share ? (
						<ShareLinkRow
							url={embedUrl(share.token)}
							onRegenerate={() => void run(() => rotate(request))}
						/>
					) : error ? null : (
						<div className="h-8 animate-pulse rounded-lg bg-muted/60 sm:h-7" />
					)}
					{error ? <p className="text-destructive-foreground text-xs">{error}</p> : null}
					<EmbedUrlOptions />
				</DialogPanel>

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Done</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

/** The query parameters a share URL understands, with examples appended to the link. */
function EmbedUrlOptions() {
	const variables = useDashboardVariablesOptional()
	const now = Date.now()

	const rows: ReadonlyArray<{ param: string; description: string; example: string }> = [
		{ param: "theme", description: "light or dark", example: "&theme=light" },
		{
			param: "from, to",
			description: "UTC, both required. Default: the dashboard's range",
			example: `&from=${warehouseDateTime(now - 12 * 3600_000)}&to=${warehouseDateTime(now)}`,
		},
		{
			param: "refresh",
			description: `Seconds: ${REFRESH_INTERVAL_OPTIONS.join(", ")} (0 = off)`,
			example: "&refresh=60",
		},
		...(variables?.variables ?? []).map((variable) => {
			const resolved = variables?.values[variable.name]
			const value = resolved?.isAll ? ALL_VALUE : (resolved?.value ?? variable.defaultValue ?? "value")
			return {
				param: `var-${variable.name}`,
				description: variable.label ?? "Dashboard variable",
				example: `&var-${variable.name}=${value}`,
			}
		}),
	]

	return (
		<div className="space-y-2">
			<div className="font-medium text-xs">URL options</div>
			<div className="divide-y divide-border overflow-hidden rounded-lg border">
				{rows.map((row) => (
					<div key={row.param} className="space-y-0.5 px-3 py-2 text-xs">
						<div className="flex items-baseline justify-between gap-3">
							<code className="shrink-0 font-mono">{row.param}</code>
							<span className="min-w-0 truncate text-right text-muted-foreground">
								{row.description}
							</span>
						</div>
						<code className="block truncate font-mono text-[11px] text-muted-foreground/80">
							{row.example}
						</code>
					</div>
				))}
			</div>
		</div>
	)
}
