import type * as React from "react"

import { ErrorState } from "@/components/common/error-state"
import { ResourceNotFound } from "@/components/common/resource-not-found"
import { Result } from "@/lib/effect-atom"

import type { BreadcrumbEntry } from "./dashboard-layout"
import { DashboardPage, type DashboardPageProps } from "./dashboard-page"

type ValueSlots =
	| "breadcrumbs"
	| "children"
	| "header"
	| "titleContent"
	| "headerActions"
	| "tabs"
	| "rightPanel"

export interface ResultPageProps<A, E, B> extends Omit<DashboardPageProps, ValueSlots> {
	/** The parent trail; the last crumb is appended per state. */
	breadcrumbs: ReadonlyArray<BreadcrumbEntry>
	result: Result.Result<A, E>
	/** Narrows the loaded value; `null`/`undefined` means "not found". Pass `(v) => v` when it can't be empty. */
	select: (value: A) => B | null | undefined
	/** Last crumb once loaded (the resource's name). */
	crumb: (value: B) => string
	/** Body before the first value. */
	loading: React.ReactNode
	/** Sticky header before the first value, usually a `DetailHeaderSkeleton`. */
	loadingHeader?: React.ReactNode
	/** Body when `select` comes back empty, usually a `ResourceNotFound`. */
	notFound?: React.ReactNode
	/** Errors that mean "no such resource" (a typed 404) render `notFound` instead of the error. */
	isNotFoundError?: (error: E) => boolean
	/** Short-circuits to this not-found body, e.g. when the route param can't be decoded. */
	invalid?: React.ReactNode
	/** Replaces the default `ErrorState` body. */
	error?: (error: E) => React.ReactNode
	errorTitle?: string
	onRetry?: () => void
	/** Loaded-state slots, mirroring `DashboardPage`'s. */
	header?: (value: B) => React.ReactNode
	titleContent?: (value: B) => React.ReactNode
	headerActions?: (value: B) => React.ReactNode
	tabs?: (value: B) => React.ReactNode
	rightPanel?: (value: B) => React.ReactNode
	children: (value: B, state: { readonly waiting: boolean }) => React.ReactNode
}

interface PageState {
	crumb: string
	body: React.ReactNode
	header?: React.ReactNode
	titleContent?: React.ReactNode
	headerActions?: React.ReactNode
	tabs?: React.ReactNode
	rightPanel?: React.ReactNode
}

const DEFAULT_NOT_FOUND = <ResourceNotFound title="Not found" />

/**
 * A detail route's one shell. Loading, error, not-found and loaded states swap only the
 * body, the header and the last breadcrumb, so the sidebar shell reconciles in place
 * instead of every branch rebuilding (and remounting) its own `DashboardLayout.Root`.
 */
export function ResultPage<A, E, B>({
	breadcrumbs,
	result,
	select,
	crumb,
	loading,
	loadingHeader,
	notFound = DEFAULT_NOT_FOUND,
	isNotFoundError,
	invalid,
	error,
	errorTitle,
	onRetry,
	header,
	titleContent,
	headerActions,
	tabs,
	rightPanel,
	children,
	...page
}: ResultPageProps<A, E, B>) {
	const notFoundState: PageState = { crumb: "Not found", body: notFound }
	const state: PageState =
		invalid !== undefined
			? { crumb: "Not found", body: invalid }
			: Result.builder(result)
					.onSuccess((value, success): PageState => {
						const selected = select(value)
						if (selected === null || selected === undefined) return notFoundState
						return {
							crumb: crumb(selected),
							body: children(selected, { waiting: success.waiting }),
							header: header?.(selected),
							titleContent: titleContent?.(selected),
							headerActions: headerActions?.(selected),
							tabs: tabs?.(selected),
							rightPanel: rightPanel?.(selected),
						}
					})
					.onError((cause): PageState => {
						if (isNotFoundError?.(cause)) return notFoundState
						return {
							crumb: "Error",
							body: error ? (
								error(cause)
							) : (
								<ErrorState error={cause} title={errorTitle} onRetry={onRetry} />
							),
						}
					})
					.orElse((): PageState => ({ crumb: "Loading…", body: loading, header: loadingHeader }))

	return (
		<DashboardPage
			{...page}
			breadcrumbs={[...breadcrumbs, { label: state.crumb }]}
			header={state.header}
			titleContent={state.titleContent}
			headerActions={state.headerActions}
			tabs={state.tabs}
			rightPanel={state.rightPanel}
		>
			{state.body}
		</DashboardPage>
	)
}
