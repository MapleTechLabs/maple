// `@maple-dev/browser/react`: an error boundary, a React 19 root error
// handler, and router adapters that drive `startNavigation`/`endNavigation`
// from the router itself. Routers are typed structurally, so this entry does
// not depend on any router package.
import { Component, type ErrorInfo, type ReactNode } from "react"
import { MapleBrowser } from "./index"

/** Component stacks can run to hundreds of lines; the top of it names the failing tree. */
const MAX_COMPONENT_STACK = 2_000

function reportReactError(error: unknown, componentStack: string | null | undefined, source: string): void {
	MapleBrowser.captureException(error, {
		name: "react.render_error",
		attributes: {
			"maple.exception.source": source,
			...(componentStack
				? { "maple.react.component_stack": componentStack.trim().slice(0, MAX_COMPONENT_STACK) }
				: undefined),
		},
	})
}

export interface MapleErrorBoundaryFallbackProps {
	// BOUNDARY: a thrown value is unparsed by definition.
	readonly error: unknown
	/** Clear the error and render the children again. */
	readonly reset: () => void
}

export interface MapleErrorBoundaryProps {
	readonly children?: ReactNode
	/** Rendered instead of the children after an error. Default: nothing. */
	readonly fallback?: ReactNode | ((props: MapleErrorBoundaryFallbackProps) => ReactNode)
	/** Called after the error is reported. */
	readonly onError?: (error: unknown, info: ErrorInfo) => void
}

interface MapleErrorBoundaryState {
	readonly failed: boolean
	readonly error: unknown
}

/** Reports render errors below it to Maple once, then renders `fallback`. */
export class MapleErrorBoundary extends Component<MapleErrorBoundaryProps, MapleErrorBoundaryState> {
	override state: MapleErrorBoundaryState = { failed: false, error: undefined }

	static getDerivedStateFromError(error: unknown): MapleErrorBoundaryState {
		return { failed: true, error }
	}

	override componentDidCatch(error: unknown, info: ErrorInfo): void {
		reportReactError(error, info.componentStack, "react.error_boundary")
		this.props.onError?.(error, info)
	}

	private readonly reset = (): void => {
		this.setState({ failed: false, error: undefined })
	}

	override render(): ReactNode {
		if (!this.state.failed) return this.props.children ?? null
		const { fallback } = this.props
		return typeof fallback === "function"
			? fallback({ error: this.state.error, reset: this.reset })
			: (fallback ?? null)
	}
}

/**
 * For React 19's `createRoot(el, { onCaughtError, onUncaughtError, onRecoverableError })`:
 * reports what React caught, with its component stack. Errors already reported
 * (by a `MapleErrorBoundary`, say) are not reported twice.
 */
export function mapleReactErrorHandler(
	source = "react.root",
): (error: unknown, info: { readonly componentStack?: string | null | undefined }) => void {
	return (error, info) => reportReactError(error, info.componentStack, source)
}

/** A React Router data router (`createBrowserRouter` and friends), as far as Maple reads it. */
export interface ReactRouterLike {
	readonly state: ReactRouterState
	subscribe(listener: (state: ReactRouterState) => void): () => void
}

export interface ReactRouterState {
	readonly initialized: boolean
	readonly location: { readonly pathname: string }
	readonly navigation: {
		readonly state: string
		readonly location?: { readonly pathname: string } | undefined
	}
	readonly matches: ReadonlyArray<{ readonly route: { readonly path?: string | undefined } }>
}

/** `/projects/:id/settings`, from the matched routes' own path segments. */
function reactRouterTemplate(state: ReactRouterState): string {
	let template = ""
	for (const match of state.matches) {
		const path = match.route.path
		if (!path) continue
		template = path.startsWith("/") ? path : `${template.replace(/\/$/, "")}/${path}`
	}
	return template || "/"
}

/**
 * Span each navigation of a React Router data router, from the moment it starts
 * loading until its loaders settle, named by route template. The first is the
 * page load. Returns an unsubscribe.
 */
export function instrumentReactRouter(router: ReactRouterLike): () => void {
	let open = false
	let pathname = router.state.location.pathname
	const start = (path: string): void => {
		MapleBrowser.startNavigation(path)
		open = true
	}
	const end = (state: ReactRouterState): void => {
		if (!open) return
		MapleBrowser.endNavigation(reactRouterTemplate(state))
		open = false
	}
	start(pathname)
	if (router.state.initialized && router.state.navigation.state === "idle") end(router.state)
	return router.subscribe((state) => {
		const target = state.navigation.location?.pathname
		if (state.navigation.state !== "idle" && target !== undefined) {
			// Same path means a search-only change or a revalidation: not a navigation.
			if (target !== pathname) start(target)
			pathname = target
			return
		}
		if (!state.initialized) return
		// A route without loaders never enters `loading`: the location just changes.
		if (!open && state.location.pathname !== pathname) start(state.location.pathname)
		pathname = state.location.pathname
		end(state)
	})
}

/** A TanStack Router instance, as far as Maple reads it. */
export interface TanStackRouterLike {
	readonly state: {
		readonly status: string
		readonly location: { readonly pathname: string }
		readonly matches: ReadonlyArray<{ readonly fullPath?: string | undefined; readonly routeId: string }>
	}
	subscribe(
		eventType: "onBeforeNavigate" | "onResolved",
		listener: (event: {
			readonly toLocation: { readonly pathname: string }
			readonly pathChanged: boolean
		}) => void,
	): () => void
}

/**
 * Span each TanStack Router navigation from `onBeforeNavigate` to `onResolved`,
 * named by the leaf route's full path (`/projects/$projectId`). Search-only
 * changes are not navigations. The first is the page load. Returns an unsubscribe.
 */
export function instrumentTanStackRouter(router: TanStackRouterLike): () => void {
	/** The path of the navigation in flight, if any. */
	let open: string | undefined
	const template = (): string => {
		const leaf = router.state.matches.at(-1)
		return leaf?.fullPath || leaf?.routeId || "/"
	}
	open = router.state.location.pathname
	MapleBrowser.startNavigation(open)
	if (router.state.status === "idle" && router.state.matches.length > 0) {
		MapleBrowser.endNavigation(template())
		open = undefined
	}
	const stopBefore = router.subscribe("onBeforeNavigate", (event) => {
		// The router's own initial load re-announces the page load already open.
		if (!event.pathChanged || event.toLocation.pathname === open) return
		open = event.toLocation.pathname
		MapleBrowser.startNavigation(open)
	})
	const stopResolved = router.subscribe("onResolved", () => {
		if (open === undefined) return
		MapleBrowser.endNavigation(template())
		open = undefined
	})
	return () => {
		stopBefore()
		stopResolved()
	}
}
