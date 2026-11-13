import type { AuditDetectionFilters } from "@maple/domain/audit-trail"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import { AppRoute, hrefOf } from "../../../route"
import type { SecurityDetectionNewSearch } from "../../../route/search"
import { categoryLabel, outcomeLabel, providerLabel } from "./audit-labels"

// A detection in words: what it counts and when it fires. The list, the editor and the ready-made
// cards all say it the same way.

export const EVERY_EVENT = "Every audit event"

/** The platform, category and outcome a detection counts, by name; empty when it counts them all. */
const matchLabels = (filters: AuditDetectionFilters): ReadonlyArray<string> => [
	...(filters.provider === undefined ? [] : [providerLabel(filters.provider)]),
	...(filters.category === undefined ? [] : [categoryLabel(filters.category)]),
	...(filters.outcome === undefined ? [] : [outcomeLabel(filters.outcome)]),
]

/** "Vercel · Credentials · Denied", without the action: that one is shown in mono beside it. */
export const matchText = (filters: AuditDetectionFilters): string => Arr.join(matchLabels(filters), " · ")

/** "10 minutes", or "2 hours" for a window of whole hours. */
const windowText = (minutes: number): string =>
	minutes >= 60 && minutes % 60 === 0 ? countLabel(minutes / 60, "hour") : countLabel(minutes, "minute")

/** "5 or more in 10 minutes". */
export const conditionText = (threshold: number, windowMinutes: number): string =>
	`${threshold.toLocaleString("en-US")} or more in ${windowText(windowMinutes)}`

/** The API refused the viewer: only org admins hold `audit_log:read`. */
export const isForbidden = (failure: LoadFailure): boolean => failure.code === "audit_trail_forbidden"

export const detectionsHref = (): string => hrefOf(AppRoute.SecurityDetections())

/** The editor: empty, prefilled, or on one detection (`detectionId`). */
export const detectionFormHref = (search: SecurityDetectionNewSearch = {}): string =>
	hrefOf(AppRoute.SecurityDetectionNew({ search }))
