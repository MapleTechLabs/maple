/**
 * A dashboard's share links, read by both the share dialog and each chart's
 * "Copy embed link" item.
 *
 * One atom per dashboard, and the same reactivity key on every mutation: a mode
 * change in the dialog re-enables (or greys out) the chart items without either
 * side knowing about the other.
 */
import { Schema } from "effect"
import { DashboardId, type DashboardShareMode } from "@maple/domain/http"
import type { V2DashboardShare } from "@maple/domain/http/v2"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"

export type ShareMode = DashboardShareMode

/**
 * The v2 atom client hands back the *decoded* record — camelCase domain names,
 * not the snake_case the wire carries — so the list is already this type.
 */
export type ShareRecord = V2DashboardShare

export const asDashboardId = Schema.decodeUnknownSync(DashboardId)

export const dashboardSharesReactivityKey = (dashboardId: string) => `dashboard-shares:${dashboardId}`

export const dashboardSharesAtom = (dashboardId: string) =>
	retainedQueryV2("dashboards", "listShares", {
		params: { id: asDashboardId(dashboardId) },
		reactivityKeys: [dashboardSharesReactivityKey(dashboardId)],
	})

export const shareUrl = (token: string) => `${window.location.origin}/share/${token}`

/** `?embed=true` drops the share page's own header, leaving only the chart. */
export const embedUrl = (token: string) => `${shareUrl(token)}?embed=true`
