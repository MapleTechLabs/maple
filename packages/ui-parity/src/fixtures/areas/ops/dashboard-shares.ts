import { Effect, Schema } from "effect"
import { V2DashboardShare, V2DashboardShareDeleteResponse } from "@maple/domain/http/v2"
import type { Dataset, EndpointHandler } from "../../dataset.ts"
import { DAY, isoBefore } from "../../identity.ts"
import { str } from "./synthetic.ts"

// `dashboards.listShares` and the share writes, answered without persisting. The platform board is
// public with one chart embedded; the payment board is shared with the org; the rest are unshared.

const PLATFORM = "dash_parity_ops_platform"
const PAYMENT = "dash_parity_ops_payment"
/** The platform board's public link (`PLATFORM_SHARE_TOKEN` in dashboards.ts). */
const PLATFORM_TOKEN = "parity_share_platform"

type Mode = "public" | "org"

const share = (dashboardId: string, mode: Mode, token: string, widgetId?: string) => ({
	id: `share_${token}`,
	object: "dashboard_share" as const,
	dashboardId,
	...(widgetId === undefined ? undefined : { widgetId }),
	mode,
	token,
	tokenSuffix: token.slice(-4),
	createdAt: isoBefore(3 * DAY),
	updatedAt: isoBefore(3 * DAY),
})

const encodeShare = Schema.encodeUnknownEffect(V2DashboardShare)
const encodeDeleted = Schema.encodeUnknownEffect(V2DashboardShareDeleteResponse)

/** The platform board's first widget: the one chart with a live embed link. */
const embeddedWidgetOf = (dataset: Dataset): string | undefined => {
	const payload = (dataset.synced.dashboards ?? []).find((row) => row.id === PLATFORM)?.payload_json
	const widgets = typeof payload === "object" && payload !== null && "widgets" in payload ? payload.widgets : []
	const first = Array.isArray(widgets) ? widgets[0] : undefined
	return typeof first === "object" && first !== null && "id" in first && typeof first.id === "string"
		? first.id
		: undefined
}

const sharesOf = (dataset: Dataset, dashboardId: string) => {
	if (dashboardId === PAYMENT) return [share(PAYMENT, "org", "parity_share_payment_org")]
	if (dashboardId !== PLATFORM) return []
	const widgetId = embeddedWidgetOf(dataset)
	return [
		share(PLATFORM, "public", PLATFORM_TOKEN),
		...(widgetId === undefined ? [] : [share(PLATFORM, "public", "parity_share_platform_chart", widgetId)]),
	]
}

const modeOf = (payload: unknown): Mode =>
	typeof payload === "object" && payload !== null && "mode" in payload && payload.mode === "org" ? "org" : "public"

export const dashboardShareEndpoints = {
	"dashboards.listShares": ({ dataset, params }) =>
		Effect.forEach(sharesOf(dataset, str(params, "id") ?? ""), (entry) => encodeShare(entry)),
	"dashboards.upsertShare": ({ params, payload }) => {
		const id = str(params, "id") ?? ""
		return encodeShare(share(id, modeOf(payload), `parity_share_${id}_${modeOf(payload)}`))
	},
	"dashboards.rotateShare": ({ params }) => {
		const id = str(params, "id") ?? ""
		return encodeShare(share(id, "public", `parity_share_${id}_rotated`))
	},
	"dashboards.revokeShare": ({ params }) =>
		encodeDeleted({ dashboardId: str(params, "id") ?? "", object: "dashboard_share", deleted: true }),
	"dashboards.upsertWidgetShare": ({ params }) => {
		const id = str(params, "id") ?? ""
		return encodeShare(share(id, "public", `parity_share_${id}_chart`, str(params, "widget_id") ?? ""))
	},
	"dashboards.rotateWidgetShare": ({ params }) => {
		const id = str(params, "id") ?? ""
		return encodeShare(share(id, "public", `parity_share_${id}_chart_rotated`, str(params, "widget_id") ?? ""))
	},
} satisfies Readonly<Record<string, EndpointHandler>>
