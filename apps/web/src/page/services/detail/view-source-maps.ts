import { shortId } from "@maple/ui/lib/ids"
import type { V2SourceMap } from "@maple/domain/http/v2"
import { Array as Arr, Option, Record as Rec } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { panel, panelBody, panelHeader, type PanelHeaderOptions } from "@maple/views/ui/panel"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"
import { isResolvableSha } from "../../kit/commit-card"
import { relativeTime } from "../../kit/relative-time"
import type { Commit } from "../../kit/service-metrics/points"
import { latestRelease, SERVICE_SOURCE_MAPS_LIMIT } from "../../kit/source-maps"
import type { Message } from "./message"
import type { Model } from "./model"

// The Overview's Source maps card: the newest release Maple can map stack traces for, and the
// GitHub repository its code lives in.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const external = (h: H) => [h.Target("_blank"), h.Rel("noopener noreferrer")]

/** The release's own commit when it resolved, else any deploy commit the page resolved. */
export const repositoryCommit = (model: Model, version: string | null): Commit | null => {
	const own = version === null ? undefined : model.commits[version]
	if (own !== undefined && AsyncData.isSuccess(own)) return own.data
	return Option.getOrNull(
		Arr.findFirst(Rec.values(model.commits), (data) =>
			AsyncData.isSuccess(data) ? Option.some(data.data) : Option.none(),
		),
	)
}

/** The newest `last_used_at` of the maps, or null when none has mapped a stack yet. */
const lastUsedOf = (maps: ReadonlyArray<V2SourceMap>): string | null =>
	Arr.reduce(maps, null as string | null, (latest, map) =>
		map.last_used_at !== null && (latest === null || map.last_used_at > latest)
			? map.last_used_at
			: latest,
	)

const releaseValue = (h: H, version: string | null, commit: Commit | null): Html | string => {
	if (version === null) return "None"
	const label = isResolvableSha(version) ? shortId(version, "sha") : version
	return commit !== null && commit.sha === version
		? textLink(h, { href: commit.htmlUrl, tone: "inherit", isMono: true, attributes: external(h) }, [
				label,
			])
		: label
}

/** The repository on GitHub, opened in a new tab. */
const repositoryLink = (h: H, repoFullName: string): Html =>
	typography(h, { size: "xs" }, [
		textLink(h, { href: `https://github.com/${repoFullName}`, tone: "muted", attributes: external(h) }, [
			icon(h, "GithubIcon", { size: 14 }),
			repoFullName,
		]),
	])

/** Nothing until the maps answer, and nothing when the service has none. */
export const sourceMapsPanel = (h: H, model: Model, clock: Clock): Html => {
	const maps = AsyncData.getOrElse(model.sourceMaps.data, (): ReadonlyArray<V2SourceMap> => [])
	const release = latestRelease(maps)
	const newest = release?.maps[0]
	if (release === null || newest === undefined) return null
	const commit = repositoryCommit(model, release.version)
	const lastUsed = lastUsedOf(release.maps)
	const fileCount = `${release.maps.length}${maps.length === SERVICE_SOURCE_MAPS_LIMIT && release.maps.length === maps.length ? "+" : ""}`
	const header: PanelHeaderOptions = {
		title: "Source maps",
		scope: typography(h, { size: "2xs", tone: "subtle" }, ["stack traces map to your code"]),
	}
	const repoLink = commit === null ? null : repositoryLink(h, commit.repoFullName)
	return panel(h, {}, [
		panelHeader(h, repoLink === null ? header : { ...header, action: repoLink }),
		panelBody(
			h,
			[
				vstack(h, { gap: "3" }, [
					keyValueList(h, {}, [
						keyValue(h, { label: "Release", mono: true }, [
							releaseValue(h, release.version, commit),
						]),
						keyValue(h, { label: "Files" }, [
							typography(h, { mono: true, numeric: true }, [fileCount]),
						]),
						keyValue(h, { label: "Uploaded" }, [
							relativeTime(h, { value: newest.created_at, ...clock, variant: "orDate" }),
						]),
						keyValue(h, { label: "Last mapped a stack" }, [
							lastUsed === null
								? typography(h, { tone: "muted" }, ["Not yet"])
								: relativeTime(h, { value: lastUsed, ...clock, variant: "orDate" }),
						]),
					]),
					...(Arr.every(release.maps, (map) => map.has_sources_content)
						? []
						: [
								typography(h, { size: "xs", tone: "muted" }, [
									"Some maps carry no sources, so their frames show a file and line without code.",
								]),
							]),
				]),
			],
			"px-4 py-3",
		),
	])
}
