import { cn } from "@maple/ui/lib/utils"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { linkButton } from "@maple/views/ui/button"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { dividedList } from "@maple/views/ui/rule"
import { hstack, hstackClass } from "@maple/views/ui/stack"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { dashboardPage } from "./dashboard-page"

/**
 * `FormSection`: one row of a form card, what it sets on the left (a title and an optional hint)
 * and its controls on the right; the two stack in a card under 36rem wide (a phone, or a form
 * beside a preview). Rows sit in a `divide-y` `formCard`, whose width they read.
 */
export const formSection = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		title: string
		hint?: string | undefined
		/** The controls sit lower than a text input's top, so a one-line control centres on the title. */
		isCompact?: boolean
		className?: string
	}>,
	children: ReadonlyArray<Html>,
): Html =>
	h.section(
		[
			h.AriaLabel(options.title),
			h.Class(
				cn(
					"grid gap-x-8 gap-y-2 px-4 py-4 @min-[36rem]/form:grid-cols-[136px_minmax(0,1fr)]",
					options.className,
				),
			),
		],
		[
			h.div(
				[
					h.Class(
						cn(
							"flex flex-col gap-0.5",
							options.isCompact === true
								? "@min-[36rem]/form:pt-1.5"
								: "@min-[36rem]/form:pt-2",
						),
					),
				],
				[
					heading(h, { level: 3, variant: "subsection" }, [options.title]),
					...(options.hint === undefined
						? []
						: [typography(h, { size: "xs", tone: "muted", as: "p" }, [options.hint])]),
				],
			),
			h.div([h.Class("flex min-w-0 flex-col gap-3")], children),
		],
	)

/** `FormScrollArea`: a form page's scroller above its action bar, the page's own scroll area. */
export const formScrollArea = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html>,
	className?: string,
): Html =>
	h.div(
		[
			h.DataAttribute("slot", "page-scroll-area"),
			h.Class(cn("min-h-0 flex-1 overflow-auto p-4", className)),
		],
		children,
	)

/** `FormCard`: the bordered card a form's sections sit in, ruled between them. */
export const formCard = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>, className?: string): Html =>
	dividedList(h, { as: "div", className: cn("@container/form bg-card", className) }, children)

/**
 * `FormActionBar`: pinned under a form's scroller, outside it, so it never floats over the form:
 * "Ready to save" or what still blocks saving, then the actions, with an optional notice above.
 * The reason wraps rather than truncates; on phones it takes its own line under the actions.
 */
export const formActionBar = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		/** What still blocks saving, one sentence each; empty is ready. */
		issues: ReadonlyArray<string>
		actions: ReadonlyArray<Html>
		/** The last save's failure, above the row. */
		notice?: Html | null
		/** The form's width, so the bar's ends line up with the card. */
		widthClass?: string
	}>,
): Html =>
	h.div(
		[h.Class("shrink-0 border-t bg-background px-4 py-3")],
		[
			...(options.notice === undefined || options.notice === null ? [] : [options.notice]),
			h.div(
				[
					h.Class(
						cn(
							"flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
							options.widthClass,
						),
					),
				],
				[
					options.issues.length === 0
						? hstack(
								h,
								{
									gap: "1.5",
									as: "span",
									className: typographyClass({
										size: "xs",
										className: "text-severity-info",
									}),
								},
								[icon(h, "CheckIcon", { size: 14 }), "Ready to save"],
							)
						: h.p(
								[
									h.AriaLabel("Fix before saving"),
									h.Class(
										hstackClass({
											gap: "1.5",
											align: "start",
											shrink: true,
											className: typographyClass({ size: "xs", tone: "muted" }),
										}),
									),
								],
								[
									icon(h, "CircleWarningIcon", {
										size: 14,
										className: "mt-px shrink-0 text-severity-warn",
									}),
									h.span(
										[],
										[
											"Fix before saving: ",
											...Arr.flatMap(options.issues, (issue, index) => [
												...(index === 0 ? [] : [" "]),
												h.span([h.Key(issue), h.Class("text-foreground")], [issue]),
											]),
										],
									),
								],
							),
					hstack(h, { gap: "2", className: "shrink-0 self-end sm:self-auto" }, options.actions),
				],
			),
		],
	)

/**
 * `ManagersOnlyPage`: what a form shows a member who may not save it, a note naming who can and
 * a way back to where they came from.
 */
export const managersOnlyPage = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		header: Readonly<{ title: string; description: string }>
		/** Who may make the change, e.g. "Only org admins and engineers can create or change SLOs". */
		title: string
		back: Readonly<{ href: string; label: string }>
	}>,
): Html =>
	dashboardPage(h, options.header, [
		alert(h, { variant: "info" }, [
			icon(h, "ShieldIcon"),
			alertTitle(h, [options.title]),
			alertDescription(h, ["Ask an admin to make this change."]),
		]),
		h.div([], [linkButton(h, { variant: "outline", href: options.back.href }, [options.back.label])]),
	])
