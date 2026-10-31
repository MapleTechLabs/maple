import { formatBytes, formatNumber } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../../ui/copy-button"
import { detailRailGroup, detailRailMetaRow } from "../../../../ui/detail-rail"
import { icon, type IconName } from "../../../../ui/icon"
import type { ZoneRow } from "../data"
import type { ZoneRailDns } from "./derive"
import { Message, type Model, type ZoneTab } from "./model"

// `CloudflareZoneRail`.

type H = HtmlBuilder<Message>

const railLink = (h: H, name: IconName, tab: ZoneTab, children: ReadonlyArray<string>): Html =>
	h.button(
		[
			h.Type("button"),
			h.OnClick(Message.ClickedTab({ tab })),
			h.Class(
				"flex items-center gap-1.5 text-left font-mono text-xs text-primary hover:text-primary active:text-primary",
			),
		],
		[icon(h, name, { className: "size-3.5 shrink-0" }), ...children],
	)

const note = (h: H, text: string): Html =>
	h.p([h.Class("text-2xs leading-relaxed text-muted-foreground")], [text])

export const zoneRail = (
	h: H,
	model: Model,
	options: Readonly<{
		serviceName: string
		accountName: string | null
		zoneRow: ZoneRow | null
		dns: ZoneRailDns | null
		firewallEvents: number | null
	}>,
): Html => {
	const { zoneRow, dns, firewallEvents } = options
	const hasLatency = zoneRow !== null && (zoneRow.ttfbP99Ms > 0 || zoneRow.originP99Ms > 0)
	const rows = [
		detailRailMetaRow(h, {
			icon: "TagIcon",
			label: "service",
			value: options.serviceName,
			copy: {
				status: model.copyService.status,
				onClick: Message.GotCopyServiceMessage({
					message: CopyButton.Message.ClickedCopy({ text: options.serviceName }),
				}),
			},
		}),
		detailRailMetaRow(h, { icon: "UserIcon", label: "account", value: options.accountName }),
		detailRailMetaRow(h, {
			icon: "ArrowUpDownIcon",
			label: "bandwidth",
			value: zoneRow === null ? null : formatBytes(zoneRow.bytes),
		}),
		detailRailMetaRow(h, {
			icon: "EyeIcon",
			label: "visits",
			value: zoneRow === null ? null : formatNumber(zoneRow.visits),
		}),
		detailRailMetaRow(h, {
			icon: "StopwatchIcon",
			label: "latency",
			value: hasLatency ? "reported" : "not on this plan",
		}),
	].filter((row): row is Html => row !== null)
	return h.div(
		[h.Class("flex flex-col")],
		[
			detailRailGroup(h, "Zone", rows),
			...(dns === null
				? []
				: [
						detailRailGroup(h, "DNS", [
							railLink(h, "GlobeIcon", "dns", [formatNumber(dns.queries), " queries"]),
							note(
								h,
								dns.alwaysNxdomain === 0
									? "Every listed name resolves."
									: `${dns.alwaysNxdomain} ${dns.alwaysNxdomain === 1 ? "name answers" : "names answer"} NXDOMAIN every time.`,
							),
						]),
					]),
			detailRailGroup(h, "Security", [
				firewallEvents === null || firewallEvents === 0
					? note(h, "No firewall events in this window.")
					: railLink(h, "ShieldCheckIcon", "security", [
							formatNumber(firewallEvents),
							" firewall events",
						]),
			]),
		],
	)
}
