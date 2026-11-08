import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"

/** The workspace card of `/cli-login` and `/mcp-authorize`; `trailing` is the Clerk switcher. */
export const workspaceCard = <M>(h: HtmlBuilder<M>, name: string, trailing: ReadonlyArray<Html>): Html =>
	hstack(
		h,
		{
			gap: "3",
			align: "center",
			justify: "between",
			className: "border border-border bg-surface-sunken px-3 py-2",
		},
		[
			h.div(
				[h.Class("min-w-0")],
				[
					typography(h, { size: "xs", tone: "muted", as: "p" }, ["Workspace"]),
					typography(h, { size: "sm", weight: "medium", truncate: true, as: "p" }, [name]),
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
