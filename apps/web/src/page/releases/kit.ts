import { formatPercent } from "@maple/ui/lib/format"
import { TONE_FILL, TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { ReleaseHealth } from "../../components/releases/release-model"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { Array as Arr, Record as Rec, String as Str, Option, Order } from "effect"

// Release health and commit helpers, shared by the list and the detail.

export const RELEASE_HEALTH_LABEL = {
	regressed: "errors up",
	watch: "latency up",
	rolling: "rolling out",
	healthy: "healthy",
} as const satisfies Record<ReleaseHealth, string>

export const RELEASE_HEALTH_DESCRIPTION = {
	regressed: "Errors at least twice as often as the version it replaced on the same service.",
	watch: "p95 latency up by a quarter or more against the version it replaced.",
	rolling: "The newest version of its service, not yet carrying the whole of the latest traffic.",
	healthy:
		"No change worth flagging against the version it replaced, or no earlier version in the window to compare with.",
} as const satisfies Record<ReleaseHealth, string>

export const RELEASE_HEALTH_DOT_CLASS = {
	regressed: TONE_FILL.crit,
	watch: TONE_FILL.warn,
	rolling: "border-2 border-primary bg-background",
	healthy: TONE_FILL.ok,
} as const satisfies Record<ReleaseHealth, string>

export const PILL_CLASS = {
	regressed: TONE_SOFT.crit,
	watch: TONE_SOFT.warn,
	rolling: "bg-primary-a2 text-primary",
	healthy: TONE_SOFT.ok,
} as const satisfies Record<ReleaseHealth, string>

/** `releaseHealthFigure`: "errors 4.1×" / "p95 +38%" / "42% rolling out". */
export const releaseHealthFigure = (impact: {
	readonly health: ReleaseHealth
	readonly errorRatio: number | undefined
	readonly p95Delta: number | undefined
	readonly share: number | undefined
}): string | undefined => {
	switch (impact.health) {
		case "regressed":
			return impact.errorRatio === undefined
				? undefined
				: Number.isFinite(impact.errorRatio)
					? `errors ${impact.errorRatio.toFixed(1)}×`
					: "errors from 0"
		case "watch":
			return impact.p95Delta === undefined ? undefined : `p95 +${formatPercent(impact.p95Delta)}`
		case "rolling":
			return impact.share === undefined ? undefined : `${formatPercent(impact.share)} rolling out`
		case "healthy":
			return undefined
	}
}

/** `isResolvableSha`: a full 40-hex git SHA, the only kind the VCS endpoint resolves. */
export const isResolvableSha = (sha: string): boolean => /^[0-9a-f]{40}$/i.test(sha)

/** `firstLine`: a commit message's subject. */
export const firstLine = (message: string): string => {
	return Str.trim(
		Option.match(Str.indexOf("\n")(message), {
			onNone: () => message,
			onSome: (index) => Str.slice(0, index)(message),
		}),
	)
}

/** `commitsQueryKey`: the resolvable shas, deduped and sorted. */
export const commitsQueryKey = (shas: Iterable<string>): string =>
	Arr.join(Arr.sort(Arr.filter([...new Set(shas)], isResolvableSha), Order.String), ",")

/** `commitRangesKey`: resolvable `base..head` pairs, deduped and sorted. */
export const commitRangesKey = (ranges: Iterable<Readonly<{ base: string; head: string }>>): string =>
	Arr.join(
		Arr.sort(
			[
				...new Set(
					Arr.map(
						Arr.filter(
							[...ranges],
							(range) => isResolvableSha(range.base) && isResolvableSha(range.head),
						),
						(range) => `${range.base}..${range.head}`,
					),
				),
			],
			Order.String,
		),
		",",
	)

/** `CommitAvatar`. TODO(avatar-error): a broken avatar URL does not fall back to initials. */
export const commitAvatar = <M>(
	h: HtmlBuilder<M>,
	url: string | null,
	name: string,
	isCompact = true,
): Html => {
	const size = isCompact ? "size-5" : "size-7"
	return url === null
		? h.div(
				[
					h.Class(
						cn(
							size,
							"flex shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium uppercase text-muted-foreground",
						),
					),
				],
				[Str.slice(0, 2)(name)],
			)
		: h.img([
				h.Src(url),
				h.Alt(""),
				h.Class(cn(size, "shrink-0 rounded-full ring-1 ring-foreground/10")),
				h.Attribute("loading", "lazy"),
				h.Attribute("referrerpolicy", "no-referrer"),
			])
}

/**
 * `<Link search={...}>` writes the query in the object's key order; `hrefOf` writes it in the
 * schema's. Reorders `href`'s query to `keys` (the rest after), keeping each value's encoding.
 */
export const withQueryOrder = (href: string, keys: ReadonlyArray<string>): string => {
	const [path, query] = Str.split("?")(href)
	if (query === undefined) return href
	const pairs = Arr.map(
		Str.split("&")(query),
		(pair) => [Arr.headNonEmpty(Str.split("=")(pair)), pair] as const,
	)
	const rank = (key: string) => {
		const index = keys.indexOf(key)
		return index === -1 ? keys.length : index
	}
	return `${path}?${Arr.join(
		Arr.map(
			Arr.sort(
				pairs,
				Order.mapInput(Order.Number, (pair: readonly [string, string]) => rank(pair[0])),
			),
			([, pair]) => pair,
		),
		"&",
	)}`
}

/** `<Link to="/releases/$commitSha" search={search}>`: the query in `search`'s key order. */
export const releaseHref = (commitSha: string, search: Readonly<Record<string, unknown>>): string =>
	withQueryOrder(hrefOf(AppRoute.Release({ commitSha, search })), Rec.keys(search))
