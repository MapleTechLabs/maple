import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { field, fieldDescription, fieldLabel } from "../../../ui/field"
import { inlineCode } from "../../../ui/inline-code"
import { settingRow } from "../../../ui/setting-row"
import { bar } from "../kit/skeletons"
import { RULES_COPY } from "./copy"
import { ALL_CATEGORIES } from "./state"
import { valueState } from "./view-fields"

// `RulesFormView` before its config loads: the real field labels and hints, bars for the values.

type Mode = "organization" | "repository"

const idsOf = (mode: Mode, slug: string) => ({
	control: `rules-skeleton-${mode}-${slug}`,
	label: `rules-skeleton-${mode}-${slug}-label`,
	error: `rules-skeleton-${mode}-${slug}-error`,
	description: `rules-skeleton-${mode}-${slug}-description`,
})

const fieldSkeleton = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		mode: Mode
		slug: string
		label: string
		control: string
		description?: string | ReadonlyArray<Html | string>
	}>,
): Html => {
	const ids = idsOf(options.mode, options.slug)
	const state = valueState(false)
	return field(h, { className: "items-stretch", state }, [
		fieldLabel(h, { ids, state }, options.label),
		bar(h, cn("w-full rounded-md", options.control)),
		...(options.description === undefined
			? []
			: [fieldDescription(h, { ids, state }, options.description)]),
	])
}

/** A switch for the organization, a select that can inherit for a repository. */
const toggleSkeleton = <M>(
	h: HtmlBuilder<M>,
	mode: Mode,
	options: Readonly<{ slug: string; label: string; description: string }>,
): Html =>
	mode === "organization"
		? settingRow(h, {
				ids: idsOf(mode, options.slug),
				label: options.label,
				description: options.description,
				control: [bar(h, "h-5 w-9 rounded-full")],
			})
		: fieldSkeleton(h, { mode, ...options, control: "h-8 sm:w-1/2" })

/** `isNested` drops its own busy region where a page-wide one already announces the load. */
export const rulesFormSkeleton = <M>(h: HtmlBuilder<M>, mode: Mode, isNested = false): Html => {
	const isRepository = mode === "repository"
	return h.div(
		[
			h.Class("flex min-w-0 flex-col gap-6"),
			...(isNested ? [] : [h.AriaBusy(true), h.AriaLabel("Loading review rules")]),
		],
		[
			fieldSkeleton(h, {
				mode,
				slug: "instructions",
				label: isRepository ? "Additional instructions" : "Instructions",
				control: "h-24",
				description: RULES_COPY.instructionsHint,
			}),
			fieldSkeleton(h, {
				mode,
				slug: "ignore",
				label: isRepository ? "Additional ignored paths" : "Ignored paths",
				control: "h-16",
				description: RULES_COPY.ignoreHint,
			}),
			h.div(
				[h.Class("flex flex-col gap-2")],
				[
					h.span(
						[h.Class("mb-2 flex items-center justify-between gap-3 text-sm font-medium")],
						["Lenses", ...(isRepository ? [bar(h, "h-4 w-40")] : [])],
					),
					h.div(
						[h.Class("grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3")],
						ALL_CATEGORIES.map(() =>
							h.span(
								[h.Class("flex h-5 items-center gap-2")],
								[bar(h, "size-4"), bar(h, "h-3 w-24")],
							),
						),
					),
					h.p([h.Class("text-xs text-muted-foreground")], [RULES_COPY.lensesHint]),
				],
			),
			h.div(
				[h.Class("grid gap-6 sm:grid-cols-2")],
				[
					fieldSkeleton(h, {
						mode,
						slug: "severity",
						...RULES_COPY.severity,
						control: "h-8",
					}),
					fieldSkeleton(h, {
						mode,
						slug: "feedback",
						...RULES_COPY.feedback,
						control: "h-8",
					}),
					fieldSkeleton(h, {
						mode,
						slug: "limit",
						...RULES_COPY.limit,
						control: "h-8",
					}),
					fieldSkeleton(h, {
						mode,
						slug: "per-pr",
						label: RULES_COPY.perPr.label,
						control: "h-8",
						description: [
							RULES_COPY.perPr.description[0],
							" ",
							inlineCode(h, {}, ["review"]),
							" ",
							RULES_COPY.perPr.description[1],
						],
					}),
				],
			),
			isRepository
				? fieldSkeleton(h, {
						mode,
						slug: "drafts",
						label: "Draft pull requests",
						control: "h-8 sm:w-1/2",
					})
				: toggleSkeleton(h, mode, {
						slug: "drafts",
						...RULES_COPY.drafts,
					}),
			toggleSkeleton(h, mode, {
				slug: "external",
				...RULES_COPY.external,
			}),
			toggleSkeleton(h, mode, {
				slug: "block-breaks",
				...RULES_COPY.blockBreaks,
			}),
			toggleSkeleton(h, mode, {
				slug: "post-merge",
				...RULES_COPY.postMerge,
			}),
			h.div(
				[h.Class("flex items-center justify-end gap-3 border-t pt-4")],
				[bar(h, "h-8 w-16 rounded-md"), bar(h, "h-8 w-16 rounded-md")],
			),
		],
	)
}
