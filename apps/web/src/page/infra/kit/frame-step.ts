import { routeWindowStep } from "../../kit/route-window"
import type * as Frame from "./frame"

// A page's frame steps beside its `FrameBlock` Binding. The Binding's OutMessage fold replaces the
// old `GotFrameMessage` lift: `ResolvedWindow` requests the page data, `ChangedTimeSearch` navigates.

export type FrameHost = Readonly<{ frame: Frame.Model }>

/**
 * A page's `routeChanged` over the frame: a moved window re-resolves (unsnapped after a Reload);
 * any other change reads under the kept window in `Load`, which starts nothing for an unmoved key.
 * `resolve` is the page's `FrameBinding.requestResolve({ scope })(model)`.
 */
export const routeFrame = <Resolved, Requested>(
	previous: Frame.Scope["search"],
	next: FrameHost,
	search: Frame.Scope["search"],
	steps: Readonly<{
		resolve: () => Resolved
		requestAll: (mode: Frame.RequestMode) => Requested
	}>,
): Resolved | Requested =>
	routeWindowStep<Resolved | Requested>(previous, search, {
		resolve: steps.resolve,
		requestAll: (mode) => (next.frame.window === null ? steps.resolve() : steps.requestAll(mode)),
	})
