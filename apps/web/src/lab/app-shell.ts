import { Effect, Option, Schema, Stream } from "effect"
import { Subscription, Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { readSessionToken } from "../platform/auth-api"
import type { Resources } from "../platform/resources"
import * as Shell from "../shell"

// Shell lab pages render inside the real shell: the same Shell Submodel the
// app root keeps, booted for the session's org, with the frame around the page and its overlays.

export const LabShellFlags = Schema.Struct({
	shell: Schema.Struct({
		isMobile: Schema.Boolean,
		theme: Shell.Theme,
		pinnedNamespaces: Schema.Record(Schema.String, Schema.String),
		dashboardFavorites: Schema.Array(Schema.String),
	}),
	maybeOrgId: Schema.Option(Schema.String),
})
export type LabShellFlags = typeof LabShellFlags.Type

const Claims = Schema.fromJsonString(Schema.Struct({ org_id: Schema.String }))
const decodeClaims = Schema.decodeUnknownOption(Claims)

/** The org of the stored self-hosted token, read from its claims. */
const orgOfToken = (token: string): Effect.Effect<Option.Option<string>> =>
	Effect.try(() => atob((token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/"))).pipe(
		Effect.map((json) => Option.map(decodeClaims(json), (claims) => claims.org_id)),
		Effect.orElseSucceed(() => Option.none()),
	)

export const labShellFlags: Effect.Effect<LabShellFlags> = Effect.all({
	shell: Shell.readShellFlags,
	maybeOrgId: Effect.flatMap(readSessionToken, (maybeToken) =>
		Option.match(maybeToken, { onNone: () => Effect.succeed(Option.none()), onSome: orgOfToken }),
	),
})

/** The shell, booted for the token's org: the sidebar's requests go out with the page. */
export const initLabShell = (
	flags: LabShellFlags,
): Update.ReturnWithOutMessage<Shell.Model, Shell.Message, Shell.OutMessage, Resources> => {
	const shell = Shell.init(flags.shell)
	return Option.match(flags.maybeOrgId, {
		onNone: () => ({ model: shell }),
		onSome: (orgId) => Shell.enter(orgId)(shell),
	})
}

/** Folds Shell Messages; a lab page has no queries to rebuild on a namespace pin. */
export const foldLabShell = <Model extends { readonly shell: Shell.Model }, Message>(
	toParentMessage: (message: Shell.Message) => Message,
) =>
	Update.foldChild({
		update: Shell.update,
		read: (model: Model) => Option.some(model.shell),
		write: (model: Model, shell: Shell.Model): Model => ({ ...model, shell }),
		toParentMessage,
		foldOutMessage: () => (model: Model) => ({ model }),
	})

/** The frame around the page, then the mobile sheet and menu layers (the root's `shellRoute`). */
export const labShellView = <Message>(
	h: HtmlBuilder<Message>,
	shell: Shell.Model,
	toParentMessage: (message: Shell.Message) => Message,
	frame: Readonly<{
		currentPath: string
		breadcrumbs: ReadonlyArray<Shell.BreadcrumbEntry>
		page: () => Html
	}>,
): ReadonlyArray<Html> => [
	h.submodel({
		slotId: "shell-frame",
		model: shell,
		view: Shell.frameView,
		toParentMessage,
		viewInputs: { ...frame, topbarActions: () => null },
	}),
	h.submodel({
		slotId: "shell-sheet",
		model: shell,
		view: Shell.sheetLayerView,
		toParentMessage,
		viewInputs: { currentPath: frame.currentPath },
	}),
	h.submodel({
		slotId: "shell-menu",
		model: shell,
		view: Shell.menuLayerView,
		toParentMessage,
		viewInputs: { currentPath: frame.currentPath },
	}),
]

/** The root's shell Subscriptions: `useIsMobile`, the sidebar shortcut and the Pinned group's shape. */
export const labShellSubscriptions = <Model extends { readonly shell: Shell.Model }, Message>(
	toParentMessage: (message: Shell.Message) => Message,
) =>
	Subscription.make<Model, Message, Resources>()((entry) => ({
		shellViewport: entry(
			{},
			{
				modelToDependencies: () => ({}),
				dependenciesToStream: () => Stream.map(Shell.viewportChanges, toParentMessage),
			},
		),
		shellSidebarShortcut: entry(
			{},
			{
				modelToDependencies: () => ({}),
				dependenciesToStream: () => Stream.map(Shell.sidebarShortcut, toParentMessage),
			},
		),
		shellDashboards: entry(
			{ orgId: Schema.NullOr(Schema.String) },
			{
				modelToDependencies: (model) => ({ orgId: Option.getOrNull(model.shell.maybeOrgId) }),
				dependenciesToStream: ({ orgId }) =>
					orgId === null
						? Stream.empty
						: Shell.pinnedDashboardRows(orgId, (dashboards) =>
								toParentMessage(Shell.Message.SucceededLoadDashboards({ orgId, dashboards })),
							),
			},
		),
	}))
