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
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import type * as CopyButton from "@maple/views/ui/copy-button"
import { textLink } from "@maple/views/ui/text-link"
import { highlightCode } from "@maple/views/lib/highlight"
import { IDENTIFY_USERS_PROMPT } from "../../components/ingest/onboard-skill"
import { agentPromptButton } from "../kit/guided-setup"

// The users pages' empty and loading states.

const IDENTIFY_EXAMPLE = Arr.join(
	[
		"// browser, after sign-in",
		"MapleBrowser.identify({",
		"  id: user.id,",
		"  email: user.email,     // optional",
		"  groupId: org.id,       // optional",
		"  groupName: org.name,   // optional",
		"})",
		"",
		"// backend auth middleware, on the root span",
		'span.setAttribute("user.id", user.id)',
	],
	"\n",
)

/** The two lines that make a user: `identify()` in the browser, `user.id` on a backend span. */
const identifyExample = <M>(h: HtmlBuilder<M>): Html =>
	h.pre(
		[
			h.Class(
				"w-full max-w-lg overflow-x-auto rounded-md border border-border bg-card px-4 py-3 text-left text-2xs leading-5",
			),
		],
		[h.code([h.InnerHTML(highlightCode(IDENTIFY_EXAMPLE, "ts"))], [])],
	)

/** `/users` before any signal carries a user id: the integration on-ramp, never demo data. */
export const noUsersState = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		promptCopy: CopyButton.Model
		toPromptCopyMessage: (message: CopyButton.Message) => M
		docsHref: string
		onWidenRange?: M | undefined
	}>,
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
					h.div(
						[h.Class("w-full max-w-lg")],
						[
							agentPromptButton(h, {
								prompt: IDENTIFY_USERS_PROMPT,
								copy: options.promptCopy,
								toCopyMessage: options.toPromptCopyMessage,
							}),
						],
					),
					typography(h, { size: "xs", tone: "subtle", as: "div" }, ["or add it by hand"]),
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
						textLink(
							h,
							{
								href: options.docsHref,
								tone: "muted",
								className: "gap-1.5 text-sm underline-offset-4",
								attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
							},
							["How to identify users", icon(h, "ExternalLinkIcon", { size: 12 })],
						),
					]),
				]),
			]),
		],
	)

/** The directory while its first read is out. */
export const usersLoading = <M>(h: HtmlBuilder<M>): Html =>
	vstack(h, { gap: "3", className: "px-6 pt-4" }, [
		skeleton(h, "h-20"),
		skeleton(h, "h-8 max-w-sm"),
		...Array.from({ length: 8 }, () => skeleton(h, "h-11")),
	])

/** One user's page while the profile read is out: the stats strip, then rows. */
export const userDetailLoading = <M>(h: HtmlBuilder<M>): Html =>
	vstack(h, { gap: "3", className: "px-6 pt-4" }, [
		skeleton(h, "h-16"),
		...Array.from({ length: 6 }, () => skeleton(h, "h-10")),
	])

/** A tab's rows while their read is out. */
export const userRowsLoading = <M>(h: HtmlBuilder<M>): Html =>
	vstack(
		h,
		{ gap: "2" },
		Array.from({ length: 6 }, () => skeleton(h, "h-9")),
	)
