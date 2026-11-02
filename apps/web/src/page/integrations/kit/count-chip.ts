import type { Tone } from "@maple/ui/lib/tone"
import type { HtmlBuilder } from "foldkit/html"
import { filterChipItem } from "../../../ui/filter-chip"
import type * as ToggleGroup from "../../../ui/toggle-group"

/** A ToggleGroup item drawn as a `filterChip`: label, optional tone dot, trailing count. */
export const countChipItem = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ value: string; label: string; count: number; tone?: Tone | undefined }>,
): ToggleGroup.ToggleGroupItem => filterChipItem(h, options)
