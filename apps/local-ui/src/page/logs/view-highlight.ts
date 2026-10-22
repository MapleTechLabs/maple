import { splitOnMatches } from "@maple/web/ui/logs/highlight"
import type { Html, HtmlBuilder } from "foldkit/html"

/**
 * Every occurrence of the active search marked,
 * mirroring the server predicate (one case-insensitive substring).
 */
export const highlightedText = <M>(
	h: HtmlBuilder<M>,
	text: string,
	query: string | undefined,
): ReadonlyArray<Html | string> =>
	query === undefined || query === ""
		? [text]
		: splitOnMatches(text, query).map((segment) =>
				segment.match
					? h.mark(
							[
								h.Class(
									"rounded-[2px] bg-primary/30 px-px text-foreground [text-decoration:inherit]",
								),
							],
							[segment.text],
						)
					: segment.text,
			)
