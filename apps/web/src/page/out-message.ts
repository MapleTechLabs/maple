import { DashboardWidgetSchema } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { ToastType } from "../ui/toast"

/**
 * What a page reports to the root, kept apart from `contract.ts` so Block-based pages (and
 * Maple Local) can import it without the `definePage` host machinery.
 */

/**
 * A toast action the root runs itself, so it outlives the page that raised it: a reconnect, or
 * a dashboard's Undo (the user may have left the board inside the toast's 6 s).
 */
export const RootToastAction = Schema.Union([
	Schema.TaggedStruct("ReconnectOrgCollections", {}),
	Schema.TaggedStruct("RestoreDashboardWidgets", {
		orgId: Schema.String,
		dashboardId: Schema.String,
		widgets: Schema.Array(DashboardWidgetSchema),
	}),
])
export type RootToastAction = typeof RootToastAction.Type

/** Facts a page reports to the root; the root owns the URL. */
export const PageOutMessage = defineMessageUnion({
	/** `navigate({ search })` / `<Link>`: the root pushes (or replaces) the URL, which re-enters the route. */
	RequestedNavigation: {
		url: Schema.String,
		isReplace: Schema.Boolean,
		/** A toast raised with the navigation (`navigate(...)` then `toastManager.add(...)`). */
		toast: Schema.optionalKey(
			Schema.Struct({ type: ToastType, title: Schema.String, description: Schema.String }),
		),
		/** A second toast after the first (a Perses import's "Imported with N warnings"). */
		followUpToast: Schema.optionalKey(
			Schema.Struct({ type: ToastType, title: Schema.String, description: Schema.String }),
		),
		/** A confirmed checkout's URL cleanup: the root re-reads the app's customer too. */
		refreshesCustomer: Schema.optionalKey(Schema.Boolean),
	},
	/** The org-global namespace pin (the shell's org menu owns it): set, or cleared with `None`. */
	RequestedNamespacePin: { maybeNamespace: Schema.Option(Schema.String) },
	/** A page's own `SidebarTrigger` (`/chat` renders its header without the shell's top bar). */
	RequestedSidebarToggle: {},
	/**
	 * `useInfraSurfaces()` in the page: the sidebar's presence probe and integration statuses. The
	 * shell owns those reads; below `md` its sidebar is unmounted, so the page is what asks for them.
	 */
	RequestedInfraSurfaces: {},
	/** `retryOrgCollections` / `handleCollectionStuck`: recreate the org's synced collections. */
	RequestedReconnectOrgCollections: {},
	/** A billing change in a page: the root re-reads the app's customer (plan gate, quota banners). */
	RequestedCustomerRefresh: {
		toast: Schema.optionalKey(
			Schema.Struct({ type: ToastType, title: Schema.String, description: Schema.String }),
		),
	},
	/**
	 * `toastManager.add`: the root shows it. `action` is the page's own Message for the action
	 * button (`actionProps`); the root sends it back to the page that is open when it is clicked.
	 */
	RequestedToast: {
		type: ToastType,
		title: Schema.String,
		description: Schema.String,
		timeoutMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		action: Schema.optionalKey(
			Schema.NullOr(Schema.Struct({ label: Schema.String, message: Schema.Unknown })),
		),
		/** An action button the root handles (`action` wins when both are set). */
		rootAction: Schema.optionalKey(Schema.Struct({ label: Schema.String, action: RootToastAction })),
	},
})
export type PageOutMessage = typeof PageOutMessage.Type
