/**
 * Embed one chart: its public link, plus the URL options an embed can carry.
 *
 * Mounted only while open, and only once the share list has loaded. On a public
 * board, mounting mints the chart's public share so the link is ready by the time
 * anyone reads it. On any other board a chart link would not resolve, so the
 * dialog says how to make the board public instead — and offers to do it. The
 * share list is the same atom the board dialog reads, so either side's changes
 * show up in the other.
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
import { ALL_VALUE, type ResolvedVariable } from "@maple/query-engine"
import { cn } from "@maple/ui/lib/utils"
import {
	ArrowRotateClockwiseIcon,
	BracketsCurlyIcon,
	ClockIcon,
	GlobeIcon,
	SunIcon,
} from "@/components/icons"
import type { DashboardVariable } from "@/components/dashboard-builder/types"
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
	const upsertBoard = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "upsertShare"), {
		mode: "promiseExit",
	})
	const rotate = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "rotateWidgetShare"), {
		mode: "promiseExit",
	})
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const shares = Result.isSuccess(sharesResult) ? (sharesResult.value as ReadonlyArray<ShareRecord>) : []
	const boardMode = shares.find((candidate) => candidate.widgetId === undefined)?.mode
	const share = shares.find((candidate) => candidate.widgetId === widgetId && candidate.mode === "public")

	const request = {
		params: { id: asDashboardId(dashboardId), widget_id: widgetId },
		reactivityKeys: [dashboardSharesReactivityKey(dashboardId)],
	}

	/** Runs the steps in order, stopping at the first failure. */
	const run = async (...steps: ReadonlyArray<() => Promise<Exit.Exit<unknown, unknown>>>) => {
		setError(null)
		setBusy(true)
		try {
			for (const step of steps) {
				const result = await step()
				if (Exit.isFailure(result)) {
					setError(displayError(result).message)
					return
				}
			}
			refreshShares()
		} finally {
			setBusy(false)
		}
	}

	const mintChartLink = () => upsert({ ...request, payload: { mode: "public" } })

	useMountEffect(() => {
		if (boardMode === "public" && share === undefined) void run(mintChartLink)
	})

	const makeBoardPublic = () =>
		void run(
			() =>
				upsertBoard({
					params: request.params,
					payload: { mode: "public" },
					reactivityKeys: request.reactivityKeys,
				}),
			...(share === undefined ? [mintChartLink] : []),
		)

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Embed chart</DialogTitle>
					<DialogDescription>
						Anyone with the link can view this chart. It stops working while the dashboard is not
						public.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4">
					{boardMode !== "public" ? (
						<NotPublicNotice
							orgOnly={boardMode === "org"}
							busy={busy}
							onMakePublic={makeBoardPublic}
						/>
					) : share ? (
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

function NotPublicNotice({
	orgOnly,
	busy,
	onMakePublic,
}: {
	orgOnly: boolean
	busy: boolean
	onMakePublic: () => void
}) {
	return (
		<div className="space-y-3 rounded-lg border bg-muted/30 px-3.5 py-3">
			<div className="flex items-start gap-3">
				<GlobeIcon size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
				<div className="space-y-1">
					<div className="font-medium text-sm">
						{orgOnly
							? "This dashboard is shared with your organization only"
							: "This dashboard isn't shared"}
					</div>
					<p className="text-muted-foreground text-xs leading-relaxed">
						Embeds only work on public dashboards. Making it public lets anyone with the
						dashboard's link view all of it, not just this chart.
					</p>
				</div>
			</div>
			<ol className="ml-7 list-decimal space-y-0.5 pl-4 text-muted-foreground text-xs leading-relaxed">
				<li>Open the ⋮ menu in the dashboard header and choose Share…</li>
				<li>Select "Anyone with the link"</li>
				<li>Reopen Embed chart from this chart's menu</li>
			</ol>
			<div className="ml-7">
				<Button size="sm" variant="outline" onClick={onMakePublic} disabled={busy}>
					<GlobeIcon />
					Make dashboard public
				</Button>
			</div>
		</div>
	)
}

interface UrlOption {
	readonly key: string
	readonly icon: typeof ClockIcon
	readonly param: string
	readonly description: string
	readonly example: string
	/** Shown for reference, but this dashboard cannot use it. */
	readonly unavailable?: boolean
}

/** An example for a variable: its current value, else its first option, else its default. */
const exampleVariableValue = (
	variable: DashboardVariable,
	resolved: ResolvedVariable | undefined,
	options: ReadonlyArray<string> | undefined,
) => {
	// `||`, not `??`: an empty textbox resolves to "", which makes a useless example.
	if (resolved !== undefined && !resolved.isAll && resolved.value !== "") return resolved.value
	return options?.[0] || variable.defaultValue || (variable.type === "textbox" ? "value" : ALL_VALUE)
}

/** The query parameters a share URL understands, each with an example to append to the link. */
function EmbedUrlOptions() {
	const variables = useDashboardVariablesOptional()
	const definitions = variables?.variables ?? []
	const now = Date.now()

	const options: ReadonlyArray<UrlOption> = [
		{
			key: "theme",
			icon: SunIcon,
			param: "theme",
			description: "light or dark",
			example: "&theme=light",
		},
		{
			key: "range",
			icon: ClockIcon,
			param: "from, to",
			description: "UTC, set both. Defaults to the dashboard's range",
			example: `&from=${warehouseDateTime(now - 12 * 3600_000)}&to=${warehouseDateTime(now)}`,
		},
		{
			key: "refresh",
			icon: ArrowRotateClockwiseIcon,
			param: "refresh",
			description: `Seconds: ${REFRESH_INTERVAL_OPTIONS.filter((value) => value > 0).join(", ")}. 0 turns it off`,
			example: "&refresh=60",
		},
		...(definitions.length === 0
			? [
					{
						key: "var",
						icon: BracketsCurlyIcon,
						param: "var-<name>",
						description: "Not available, this dashboard has no variables",
						example: "&var-service=checkout",
						unavailable: true,
					},
				]
			: definitions.map((variable) => ({
					key: `var-${variable.name}`,
					icon: BracketsCurlyIcon,
					param: `var-${variable.name}`,
					description: variable.label ?? "Dashboard variable",
					example: `&var-${variable.name}=${exampleVariableValue(
						variable,
						variables?.values[variable.name],
						variables?.optionsByName[variable.name]?.options,
					)}`,
				}))),
	]

	return (
		<div className="space-y-2">
			<div>
				<div className="font-medium text-xs">URL options</div>
				<p className="text-muted-foreground text-xs">Append any of these to the embed link.</p>
			</div>
			{/* Three fixed columns on every row — icon, parameter, details — so names,
			    descriptions and examples line up down the list whatever their length. */}
			<ul className="divide-y divide-border overflow-hidden rounded-lg border">
				{options.map(({ key, icon: Icon, param, description, example, unavailable }) => (
					<li
						key={key}
						className={cn(
							"grid grid-cols-[1rem_6.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 px-3 py-2.5 text-xs leading-5",
							unavailable && "opacity-60",
						)}
					>
						<span className="flex h-5 items-center text-muted-foreground">
							<Icon size={14} />
						</span>
						<code className="truncate font-medium font-mono" title={param}>
							{param}
						</code>
						<span className="text-muted-foreground">{description}</span>
						<code className="col-start-3 w-fit max-w-full truncate rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
							{example}
						</code>
					</li>
				))}
			</ul>
		</div>
	)
}
