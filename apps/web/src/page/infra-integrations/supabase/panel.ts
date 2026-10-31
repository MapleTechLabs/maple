import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Keyed } from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { AppRoute, hrefOf } from "../../../route"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { skeleton } from "../../../ui/skeleton"
import { panel, panelHeader, panelTitle } from "../../../ui/panel"

// The Supabase pages' panel frame, header link, row skeleton and load states.

/** Where a project's Metrics and Logs switches live. */
export const MANAGE_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "supabase" } }))

export const sectionPanel = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; description?: string; action?: Html; className?: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	panel(h, { className: options.className }, [
		panelHeader(h, {
			action: options.action,
			children: [
				h.div(
					[h.Class("flex min-w-0 flex-col gap-0.5")],
					[
						panelTitle(h, [options.title]),
						...(options.description === undefined
							? []
							: [h.p([h.Class("text-2xs text-foreground-subtle")], [options.description])]),
					],
				),
			],
		}),
		...children,
	])

export const panelLink = <M>(h: HtmlBuilder<M>, href: string, label: string): Html =>
	h.a(
		[h.Href(href), h.Class("text-2xs text-muted-foreground hover:text-foreground active:text-foreground")],
		[`${label} →`],
	)

export const panelMeta = <M>(h: HtmlBuilder<M>, text: string, className?: string): Html =>
	h.span([h.Class(cn("font-mono text-2xs tabular-nums text-muted-foreground", className))], [text])

export const rowsLoading = <M>(h: HtmlBuilder<M>, count: number): Html =>
	h.div(
		[h.Class("space-y-3 p-4"), h.AriaBusy(true)],
		Array.from({ length: count }, () => skeleton(h, "h-4 w-full")),
	)

export const panelEmpty = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
	h.div([h.Class("p-4")], [emptyMessage(h, {}, children)])

export const panelError = <M>(h: HtmlBuilder<M>, failure: LoadFailure, title: string, onRetry: M): Html =>
	h.div([h.Class("p-4")], [errorState(h, { failure, title, variant: "inline", onRetry })])

/** A read's panel body: rows while loading, the failure with a retry, else `render` (stale data stays). */
export const keyedBody = <A, M>(
	h: HtmlBuilder<M>,
	slot: Keyed<A, LoadFailure>,
	options: Readonly<{ rows: number; failureTitle: string; onRetry: M; render: (data: A) => Html }>,
): Html =>
	AsyncData.match(slot.data, {
		onIdle: () => rowsLoading(h, options.rows),
		onLoading: () => rowsLoading(h, options.rows),
		onFailure: (failure) => panelError(h, failure, options.failureTitle, options.onRetry),
		onStale: ({ data }) => options.render(data),
		onRefreshing: (data) => options.render(data),
		onSuccess: (data) => options.render(data),
	})
