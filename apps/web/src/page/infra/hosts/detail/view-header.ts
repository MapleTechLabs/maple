import { severityLevel } from "../../../../components/infra/format"
import { formatLoad, formatPercent } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { button, linkButton } from "../../../../ui/button"
import { skeleton } from "../../../../ui/skeleton"
import { heroChip } from "../../kit/hero-chip"
import { platformLabel } from "../../kit/meta-line"
import { pageHero } from "../../kit/page-parts"
import { relativeTime } from "../../../kit/relative-time"
import { statRail, statRailItem, statRailLoading } from "../../../kit/stat-rail"
import { hostStatusBadge } from "../../kit/status"
import { Message } from "./message"
import type { HostSummary } from "./model"

// `HostDetailHeader` / `HostDetailHeaderLoading` and `HeroChip`.

type H = HtmlBuilder<Message>

export const hostDetailHeaderLoading = (h: H): Html =>
	h.div(
		[h.Class("space-y-6")],
		[h.div([], [skeleton(h, "h-7 w-72"), skeleton(h, "mt-2 h-3 w-96")]), statRailLoading(h)],
	)

type HeaderInputs = Readonly<{
	summary: HostSummary
	hostName: string
	nowMs: number
	timeZone: string
	canWiden: boolean
}>

const noData = (h: H, inputs: HeaderInputs): Html =>
	pageHero(h, {
		title: h.span([h.Class("font-mono")], [inputs.hostName]),
		description:
			"This host sent no metrics in the selected time window. It may have stopped reporting earlier: try a wider range, or go back to the hosts list.",
		actions: [
			...(inputs.canWiden
				? [
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								attributes: [h.OnClick(Message.ClickedWidenRange())],
							},
							["Show last 7 days"],
						),
					]
				: []),
			linkButton(
				h,
				{ variant: "outline", size: "sm", href: hrefOf(AppRoute.InfraHosts({ search: {} })) },
				["Back to hosts"],
			),
		],
	})

export const hostDetailHeader = (h: H, inputs: HeaderInputs): Html => {
	const summary = inputs.summary
	if (summary === null) return noData(h, inputs)
	const meta = [
		...(summary.osType ? [heroChip(h, [platformLabel(h, "os", summary.osType)])] : []),
		...(summary.hostArch ? [heroChip(h, [platformLabel(h, "arch", summary.hostArch)])] : []),
		...(summary.cloudProvider ? [heroChip(h, [platformLabel(h, "cloud", summary.cloudProvider)])] : []),
		...(summary.cloudRegion ? [heroChip(h, ["region ", summary.cloudRegion])] : []),
		relativeTime(h, {
			value: summary.lastSeen,
			nowMs: inputs.nowMs,
			timeZone: inputs.timeZone,
			prefix: "last reported",
			className: "text-2xs text-muted-foreground/80",
		}),
	]
	const percentItem = (eyebrow: string, value: number) =>
		statRailItem(h, {
			eyebrow,
			value: formatPercent(value),
			tone: severityLevel(value),
			subline: "warn ≥ 80%",
			compact: true,
		})
	return h.div(
		[h.Class("space-y-6")],
		[
			pageHero(h, {
				title: h.span([h.Class("font-mono")], [summary.hostName]),
				meta,
				trailing: [hostStatusBadge(h, { lastSeen: summary.lastSeen, referenceMs: inputs.nowMs })],
			}),
			statRail(h, {}, [
				percentItem("CPU", summary.cpuPct),
				percentItem("Memory", summary.memoryPct),
				percentItem("Disk", summary.diskPct),
				statRailItem(h, { eyebrow: "Load 15m", value: formatLoad(summary.load15), compact: true }),
			]),
		],
	)
}
