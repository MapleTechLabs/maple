import type { ErrorIssueAffectedUsersResponse } from "@maple/domain/http"
import { EMPTY_VALUE, formatNumber, formatPercent } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AsyncData } from "foldkit"
import { Array as Arr } from "effect"
import { detailRailField, detailRailGroup, detailRailRow } from "@maple/views/ui/detail-rail"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../../route"
import { ERRORS_ATTRIBUTED_FROM } from "../../users/data"
import type { Message } from "./message"
import type { Model } from "./model"

// The rail's Affected users group: how many end users the issue hit in the window, how many of
// its hits named a user at all, and the users it hit most, each opening their user page.

type H = HtmlBuilder<Message>

const USERS_SHOWN = 5

/** Hits that named a user over all hits, 0 to 1; `null` with no hits in the window. */
export const coverageOf = (response: Pick<ErrorIssueAffectedUsersResponse, "hits" | "hitsWithUser">) =>
	response.hits === 0 ? null : Math.min(1, response.hitsWithUser / response.hits)

const muted = (h: H, text: string): Html => typography(h, { size: "xs", tone: "muted" }, [text])

/** A user's page over the issue page's window. */
export const affectedUserHref = (userId: string, search: Model["search"]): string =>
	hrefOf(
		AppRoute.UserDetail({
			userId,
			search: { startTime: search.startTime, endTime: search.endTime, timePreset: search.timePreset },
		}),
	)

const userList = (h: H, users: ErrorIssueAffectedUsersResponse["users"], search: Model["search"]): Html =>
	h.ul(
		[h.Class("flex w-full min-w-0 flex-col items-stretch gap-0.5")],
		Arr.map(users.slice(0, USERS_SHOWN), (user) =>
			h.li(
				[h.Class("flex min-w-0 items-baseline justify-between gap-3")],
				[
					textLink(
						h,
						{
							href: affectedUserHref(user.userId, search),
							isMono: true,
							className: "min-w-0 truncate text-xs",
							attributes: [h.Title(user.userId)],
						},
						[user.userId],
					),
					typography(
						h,
						{ size: "2xs", tone: "muted", mono: true, numeric: true, className: "shrink-0" },
						[formatNumber(user.hits)],
					),
				],
			),
		),
	)

const attributedRows = (
	h: H,
	response: ErrorIssueAffectedUsersResponse,
	search: Model["search"],
): ReadonlyArray<Html> => {
	const coverage = coverageOf(response)
	return [
		detailRailRow(h, { label: "Users", hint: "in this window" }, [
			typography(h, { size: "sm", tone: "foreground", numeric: true }, [
				formatNumber(response.affectedUsers),
			]),
		]),
		detailRailRow(
			h,
			{
				label: "Coverage",
				title: `${formatNumber(response.hitsWithUser)} of ${formatNumber(response.hits)} hits named a user`,
			},
			[
				typography(h, { size: "sm", tone: "foreground", numeric: true }, [
					coverage === null ? EMPTY_VALUE : `${formatPercent(coverage)} of hits`,
				]),
			],
		),
		...(response.users.length > 0
			? [detailRailField(h, { label: "Most hit" }, [userList(h, response.users, search)])]
			: []),
		typography(h, { size: "2xs", tone: "muted" }, [
			`Users are tracked from ${ERRORS_ATTRIBUTED_FROM} on.`,
		]),
	]
}

/** The group, or its loading, failed and unattributed states in the same place. */
export const affectedUsersGroup = (h: H, model: Model): Html =>
	detailRailGroup(
		h,
		"Affected users",
		AsyncData.matchData(model.affectedUsers.data, {
			onEmpty: () => [detailRailRow(h, { label: "Users" }, [muted(h, EMPTY_VALUE)])],
			onFailure: () => [muted(h, "Couldn't load the users this issue hit.")],
			onData: (response) =>
				response.attributed
					? attributedRows(h, response, model.search)
					: [muted(h, "This warehouse's errors carry no user id yet.")],
		}),
	)
