import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"

/** The workspace card of `/cli-login` and `/mcp-authorize`; `trailing` is the Clerk switcher. */
export const workspaceCard = <M>(h: HtmlBuilder<M>, name: string, trailing: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("flex items-center justify-between gap-3 border border-border bg-muted/30 px-3 py-2")],
		[
			h.div(
				[h.Class("min-w-0")],
				[
					h.p([h.Class("text-xs text-muted-foreground")], ["Workspace"]),
					h.p([h.Class("truncate text-sm font-medium")], [name]),
				],
			),
			...trailing,
		],
	)

/** `WorkspaceChoice`: self-hosted names the session's org id. */
export const selfHostedWorkspace = <M>(h: HtmlBuilder<M>, maybeOrgId: Option.Option<string>): Html =>
	workspaceCard(
		h,
		Option.getOrElse(maybeOrgId, () => ""),
		[],
	)
