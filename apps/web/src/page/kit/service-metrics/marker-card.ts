import { shortId } from "@maple/ui/lib/ids"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as HoverCard from "@maple/views/ui/hover-card"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import { commitAvatar, firstLine, isResolvableSha } from "../commit-card"
import { relativeTime } from "../relative-time"
import type { MarkerCommit } from "./marker-layout"
import type { CommitData } from "./points"

// The card a commit marker opens on hover: every commit first seen in that bucket,
// the representative first.

/** A marker card lists at most this many commits; the rest are counted. */
export const MARKER_CARD_COMMITS = 8

/** One card per page, shared by every marker on every chart. */
export const initMarkerCard = (id: string): HoverCard.Model =>
	HoverCard.init(id, { openDelayMs: 300, side: "bottom", align: "center", sideOffset: 6 })

/** What a markers overlay needs to open the card: the page's card, its commits and its clock. */
export type MarkerCard<M> = Readonly<{
	model: HoverCard.Model
	toParent: (message: HoverCard.Message) => M
	commits: Readonly<Record<string, CommitData>>
	clock: Readonly<{ nowMs: number; timeZone: string }>
}>

const commitRow = <M>(h: HtmlBuilder<M>, card: MarkerCard<M>, commit: MarkerCommit): Html => {
	const data = card.commits[commit.sha]
	const sha = isResolvableSha(commit.sha) ? shortId(commit.sha, "sha") : commit.sha
	const shaText = typography(h, { size: "2xs", tone: "muted", mono: true, className: "shrink-0" }, [sha])
	if (data === undefined || !AsyncData.isSuccess(data)) {
		const isLoading = data !== undefined && AsyncData.isLoading(data)
		return hstack(h, { gap: "2.5", className: "px-3 py-2" }, [
			isLoading ? skeleton(h, "size-5 shrink-0 rounded-full") : commitAvatar(h, null, "?"),
			isLoading
				? skeleton(h, "h-3 flex-1")
				: typography(h, { size: "xs", tone: "muted", className: "flex-1" }, [
						"Commit details unavailable",
					]),
			shaText,
		])
	}
	const detail = data.data
	const author = detail.authorLogin ?? detail.authorName ?? "Unknown author"
	return hstack(h, { gap: "2.5", align: "start", className: "px-3 py-2" }, [
		commitAvatar(h, detail.authorAvatarUrl, author),
		vstack(h, { gap: "0.5", shrink: true, grow: true }, [
			typography(h, { size: "xs", weight: "medium", truncate: true }, [firstLine(detail.message)]),
			hstack(h, { gap: "1", shrink: true }, [
				typography(h, { size: "2xs", tone: "muted", truncate: true }, [author]),
				typography(h, { size: "2xs", tone: "faint" }, ["·"]),
				relativeTime(h, {
					value: detail.committedAt,
					...card.clock,
					variant: "short",
					className: "shrink-0 text-2xs text-muted-foreground",
				}),
			]),
		]),
		shaText,
	])
}

/** The card's body for one marker group: a header, one row per commit, and the overflow count. */
export const markerCardBody = <M>(
	h: HtmlBuilder<M>,
	card: MarkerCard<M>,
	commits: ReadonlyArray<MarkerCommit>,
): ReadonlyArray<Html> => {
	const shown = commits.slice(0, MARKER_CARD_COMMITS)
	const hidden = commits.length - shown.length
	const count = commits.length
	return [
		typography(
			h,
			{ size: "2xs", tone: "muted", as: "div", className: "border-b border-border-subtle px-3 py-2" },
			[count === 1 ? "1 commit deployed" : `${count} commits deployed`],
		),
		vstack(
			h,
			{ className: "py-1" },
			Arr.map(shown, (commit) => commitRow(h, card, commit)),
		),
		...(hidden > 0
			? [
					typography(
						h,
						{
							size: "2xs",
							tone: "muted",
							as: "div",
							className: "border-t border-border-subtle px-3 py-2",
						},
						[`+${hidden} more`],
					),
				]
			: []),
	]
}
