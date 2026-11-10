import { Effect, Option, Schema, Stream, String as Str } from "effect"
import { Subscription, type Update } from "foldkit"
import { readSessionToken } from "../platform/auth-api"
import type { Resources } from "../platform/resources"
import * as Shell from "../shell"

export { foldLabShell, labShellView } from "./shell-frame"

// Shell lab pages render inside the real shell: the same Shell Submodel the
// app root keeps, booted for the session's org, with the frame around the page and its overlays.

export const LabShellFlags = Schema.Struct({
	shell: Schema.Struct({
		isMobile: Schema.Boolean,
		theme: Shell.Theme,
		pinnedNamespaces: Schema.Record(Schema.String, Schema.String),
		dashboardFavorites: Schema.Array(Schema.String),
		collapsedNavGroups: Schema.optionalKey(Schema.Array(Schema.String)),
	}),
	maybeOrgId: Schema.Option(Schema.String),
})
export type LabShellFlags = typeof LabShellFlags.Type

const Claims = Schema.fromJsonString(Schema.Struct({ org_id: Schema.String }))
const decodeClaims = Schema.decodeUnknownOption(Claims)

export class LabTokenDecodeError extends Schema.TaggedError<LabTokenDecodeError>()(
	"@maple/web/lab/LabTokenDecodeError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** The org of the stored self-hosted token, read from its claims. */
const orgOfToken = (token: string): Effect.Effect<Option.Option<string>> =>
	Effect.try({
		try: () => atob(Str.replaceAll("_", "/")(Str.replaceAll("-", "+")(Str.split(".")(token)[1] ?? ""))),
		catch: (cause) => new LabTokenDecodeError({ message: "The stored token is not base64url", cause }),
	}).pipe(
		Effect.map((json) => Option.map(decodeClaims(json), (claims) => claims.org_id)),
		Effect.orElseSucceed(() => Option.none()),
	)

export const labShellFlags: Effect.Effect<LabShellFlags> = Effect.all({
	shell: Shell.readShellFlags,
	maybeOrgId: Effect.flatMap(readSessionToken, (maybeToken) =>
		Option.match(maybeToken, { onNone: () => Effect.succeedNone, onSome: orgOfToken }),
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

/** The root's shell Subscriptions: the viewport query, the sidebar shortcut and the Pinned group's shape. */
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
