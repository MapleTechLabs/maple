import type { V2SetupAuditCheck } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { inlineCode, inlineCodeClassName } from "@maple/views/ui/inline-code"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"

type Entity = V2SetupAuditCheck["affected"][number]

const chipClassName = "text-2xs leading-4"

const affectedChip = <M>(h: HtmlBuilder<M>, entity: Entity, index: number): Html => {
	const title = entity.note === null ? [] : [h.Title(entity.note)]
	const key = h.Key(entity.id === null ? `index:${index}` : `id:${entity.kind}:${entity.id}`)
	if (entity.kind === "service")
		return h.a(
			[key, h.Href(`/services/${encodeURIComponent(entity.name)}`), ...title],
			[
				inlineCode(
					h,
					{
						className: cn(
							chipClassName,
							"text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground active:decoration-foreground",
						),
					},
					[entity.name],
				),
			],
		)
	return h.code(
		[
			key,
			...title,
			h.Class(inlineCodeClassName("chip", cn(chipClassName, "text-muted-foreground"))),
			h.DataAttribute("slot", "inline-code"),
		],
		[entity.name],
	)
}

/** The entities a setup-health check names, as chips with a "+N more" for the rest past the cap.
 * Renders nothing when the check names none; `className` is the caller's spacing. */
export const affectedChips = <M>(
	h: HtmlBuilder<M>,
	check: Pick<V2SetupAuditCheck, "affected" | "affected_count">,
	options: Readonly<{ className?: string }> = {},
): ReadonlyArray<Html> =>
	check.affected.length === 0
		? []
		: [
				hstack(h, { gap: "1.5", wrap: true, className: options.className }, [
					...Arr.map(check.affected, (entity, index) => affectedChip(h, entity, index)),
					...(check.affected_count > check.affected.length
						? [
								typography(h, { size: "2xs", tone: "subtle" }, [
									`+${check.affected_count - check.affected.length} more`,
								]),
							]
						: []),
				]),
			]
