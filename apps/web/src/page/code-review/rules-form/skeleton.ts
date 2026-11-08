import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { field, fieldDescription, fieldLabel } from "@maple/views/ui/field"
import { inlineCode } from "@maple/views/ui/inline-code"
import { settingRow } from "@maple/views/ui/setting-row"
import { bar } from "../kit/skeletons"
import { RULES_COPY } from "./copy"
import { ALL_CATEGORIES } from "./state"
import { valueState } from "./view-fields"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { skeletonSwitchClass } from "@maple/views/ui/skeleton"
import { Array as Arr } from "effect"

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
				control: [bar(h, skeletonSwitchClass())],
			})
		: fieldSkeleton(h, { mode, ...options, control: "h-8 sm:w-1/2" })

export const rulesFormSkeleton = <M>(h: HtmlBuilder<M>, mode: Mode): Html => {
	const isRepository = mode === "repository"
	return vstack(
		h,
		{ gap: "6", shrink: true, attributes: [h.AriaBusy(true), h.AriaLabel("Loading review rules")] },
		[
			fieldSkeleton(h, {
				mode,
				slug: "instructions",
				label: isRepository ? "Additional instructions" : "Instructions",
				control: "h-[98px]",
				description: RULES_COPY.instructionsHint,
			}),
			fieldSkeleton(h, {
				mode,
				slug: "ignore",
				label: isRepository ? "Additional ignored paths" : "Ignored paths",
				control: "h-[68px]",
				description: RULES_COPY.ignoreHint,
			}),
			vstack(h, { gap: "2" }, [
				hstack(
					h,
					{
						gap: "3",
						align: "center",
						justify: "between",
						as: "span",
						className: "mb-2 text-sm font-medium",
					},
					["Lenses", ...(isRepository ? [bar(h, "h-4 w-40")] : [])],
				),
				h.div(
					[h.Class("grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3")],
					Arr.map(ALL_CATEGORIES, () =>
						hstack(h, { gap: "2", align: "center", as: "span", className: "h-5" }, [
							bar(h, "size-4"),
							bar(h, "h-3 w-24"),
						]),
					),
				),
				typography(h, { size: "xs", tone: "muted", as: "p" }, [RULES_COPY.lensesHint]),
			]),
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
			hstack(h, { gap: "3", align: "center", justify: "end", className: "border-t pt-4" }, [
				bar(h, "h-8 w-16 rounded-md"),
				bar(h, "h-8 w-16 rounded-md"),
			]),
		],
	)
}
