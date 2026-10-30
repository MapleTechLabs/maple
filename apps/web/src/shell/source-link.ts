import type { V2Source } from "@maple/domain/http/v2"
import type { PullSourcePlatform } from "@maple/domain/primitives"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { platformMeta } from "../page/sources/kit/platforms"
import { sourceHref, toPublicSourceId } from "../page/sources/kit/shared"
import { AppRoute, hrefOf } from "../route"
import { linkButton } from "../ui/button"
import { icon } from "../ui/icon"

// The top bar's link from a page to the source its data came from.

/** An integration page names its platform; a telemetry page names the `src_` id stamped on its data. */
export type PageSourceRef =
	| Readonly<{ _tag: "Platform"; platform: PullSourcePlatform }>
	| Readonly<{ _tag: "Id"; sourceId: string }>

export const platformSource = (platform: PullSourcePlatform): PageSourceRef => ({
	_tag: "Platform",
	platform,
})

export const idSource = (sourceId: string): PageSourceRef | null =>
	sourceId === "" ? null : { _tag: "Id", sourceId }

/** The source stamped on a loaded summary row (a host, a container, a pod). */
export const summarySource = <E>(
	summary: AsyncData.AsyncData<Readonly<{ sourceId?: string }> | null, E>,
): PageSourceRef | null =>
	Option.match(AsyncData.getData(summary), {
		onNone: () => null,
		onSome: (row) => (row === null ? null : idSource(row.sourceId ?? "")),
	})

export type SourceLink = Readonly<{ label: string; href: string; source: V2Source | null }>

const byPublicId = (sources: ReadonlyArray<V2Source>, publicId: string): V2Source | null =>
	sources.find((source) => toPublicSourceId(source.id) === publicId) ?? null

/** The list knows the source: a fresh connect or a new token is missing until a re-read. */
export const isResolved = (ref: PageSourceRef, sources: ReadonlyArray<V2Source>): boolean =>
	ref._tag === "Id"
		? byPublicId(sources, ref.sourceId) !== null
		: sources.some((source) => source.platform === ref.platform)

/**
 * The link for a page's source: one source opens its page, several open the Sources list. An id
 * links even before the list answers; a platform with no source yet links nowhere.
 */
export const resolveSourceLink = (
	ref: PageSourceRef,
	sources: ReadonlyArray<V2Source> | null,
): SourceLink | null => {
	if (ref._tag === "Id") {
		const source = sources === null ? null : byPublicId(sources, ref.sourceId)
		return {
			label: source?.name ?? "Source",
			href: hrefOf(AppRoute.Source({ sourceId: ref.sourceId, search: {} })),
			source,
		}
	}
	const matches = (sources ?? []).filter((source) => source.platform === ref.platform)
	const [only] = matches
	if (only === undefined) return null
	return matches.length === 1
		? { label: only.name, href: sourceHref(only), source: only }
		: {
				label: `${matches.length} ${platformMeta(ref.platform).label} sources`,
				href: hrefOf(AppRoute.Sources()),
				source: null,
			}
}

/** An outline button with the source's platform icon and name. */
export const sourceLinkButton = <M>(h: HtmlBuilder<M>, link: SourceLink): Html =>
	linkButton(
		h,
		{
			size: "sm",
			variant: "outline",
			href: link.href,
			className: "max-w-56",
			attributes: [h.Title(`Source: ${link.label}`)],
		},
		[
			icon(h, link.source === null ? "ConnectionIcon" : platformMeta(link.source.platform).icon),
			h.span([h.Class("truncate")], [link.label]),
		],
	)
