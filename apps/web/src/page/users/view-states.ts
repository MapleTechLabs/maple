import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"

// The users pages' empty and loading states.

const IDENTIFY_EXAMPLE: ReadonlyArray<readonly [string, string]> = [
	["identify({", ""],
	["  id: user.id,", ""],
	["  email: user.email,", "# optional"],
	["  name: user.name,", "# optional"],
	["  traits: { plan: org.plan },", "# optional"],
	["})", ""],
]

const SERVER_EXAMPLE = 'span.setAttribute("user.id", user.id)'

/** The two lines that make a user: `identify()` in the browser, `user.id` on a backend span. */
const identifyExample = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[
			h.Class(
				"w-full max-w-lg rounded-md border border-border bg-card px-4 py-3 text-left font-mono text-2xs leading-5",
			),
		],
		[
			typography(h, { size: "2xs", tone: "subtle", as: "div" }, ["// browser, after sign-in"]),
			...Arr.map(IDENTIFY_EXAMPLE, ([code, comment]) =>
				hstack(h, { gap: "3" }, [
					h.span([h.Class("w-48 shrink-0 whitespace-pre text-foreground")], [code]),
					typography(h, { size: "2xs", tone: "subtle", as: "span" }, [comment]),
				]),
			),
			typography(h, { size: "2xs", tone: "subtle", as: "div", className: "mt-2" }, [
				"// backend, any OpenTelemetry SDK",
			]),
			h.div([h.Class("text-foreground")], [SERVER_EXAMPLE]),
		],
	)

/** `/users` before any signal carries a user id: the integration on-ramp, never demo data. */
export const noUsersState = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ onSetup: M; docsHref: string; onWidenRange?: M | undefined }>,
): Html =>
	h.div(
		[h.Class("border-t border-border px-6 py-14")],
		[
			empty(h, [
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "UsersIcon")]),
					emptyTitle(h, ["No identified users in this window"]),
					emptyDescription(h, [
						"Nothing in this window carries a user id. If your SDKs don't identify users yet, add one where you know who is signed in, and every session, trace, log, error and event from that person lands on one page.",
					]),
				]),
				emptyContent(h, [
					identifyExample(h),
					hstack(h, { gap: "4", wrap: true, justify: "center" }, [
						...(options.onWidenRange === undefined
							? []
							: [
									button(
										h,
										{
											size: "sm",
											variant: "outline",
											attributes: [h.OnClick(options.onWidenRange)],
										},
										["Show the last month"],
									),
								]),
						button(h, { size: "sm", attributes: [h.OnClick(options.onSetup)] }, [
							icon(h, "PlugIcon", { size: 14 }),
							"Set up identify()",
						]),
						h.a(
							[
								h.Href(options.docsHref),
								h.Target("_blank"),
								h.Rel("noopener noreferrer"),
								h.Class(
									"inline-flex items-center gap-1.5 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline active:text-foreground active:underline",
								),
							],
							["Identifying users", icon(h, "ExternalLinkIcon", { size: 12 })],
						),
					]),
				]),
			]),
		],
	)

/** The directory while its first read is out. */
export const usersLoading = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex flex-col gap-3 px-6 pt-4")],
		[
			skeleton(h, "h-20"),
			skeleton(h, "h-8 max-w-sm"),
			...Array.from({ length: 8 }, () => skeleton(h, "h-11")),
		],
	)
