import { Duration, Effect, Stream } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"

// The dashboards pages' live-sync fallback: the bounded wait on the shape stream, and the banner
// shown while an HTTP snapshot stands in for it.

/** `COLLECTION_LOAD_TIMEOUT_MS`: how long a live read may load before the HTTP snapshot stands in. */
export const COLLECTION_LOAD_TIMEOUT_MS = 10_000

/** `useCollectionLoadFailed`: one message once the live read has loaded past the timeout. */
export const loadTimeout = <M>(message: M): Stream.Stream<M> =>
	Stream.fromEffect(Effect.as(Effect.sleep(Duration.millis(COLLECTION_LOAD_TIMEOUT_MS)), message))

/** `SyncDegradedBanner`: what is shown is a frozen HTTP snapshot and writes are off. */
export const snapshotBanner = <M>(h: HtmlBuilder<M>, subject: string, onRetry: M): Html =>
	h.div(
		[
			h.Class(
				"mb-3 flex items-start gap-2 rounded-md border border-border bg-surface-sunken p-2.5 text-xs text-muted-foreground",
			),
		],
		[
			icon(h, "CircleWarningIcon", { size: 14, className: "mt-0.5 shrink-0" }),
			h.span(
				[h.Class("flex-1")],
				[
					`Live sync is unavailable, so ${subject} is a snapshot loaded over HTTP. It won’t update on its own and editing is disabled.`,
				],
			),
			button(
				h,
				{
					size: "xs",
					variant: "ghost",
					className: "-my-1 shrink-0 hover:text-foreground active:text-foreground",
					attributes: [h.OnClick(onRetry)],
				},
				["Retry sync"],
			),
		],
	)
