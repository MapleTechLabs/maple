import type { V2AlertSilence } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { endsAtMs, formatSilenceTime } from "./silences"

/** "Silenced until 15:00": the silence holding back a rule's or an incident's notifications. */
export const silenceBadge = <M>(
	h: HtmlBuilder<M>,
	silence: V2AlertSilence,
	nowMs: number,
	timeZone: string,
): Html =>
	badge(h, { variant: "outline", attributes: [h.Title(silence.reason)] }, [
		icon(h, "BellSlashIcon"),
		`Silenced until ${formatSilenceTime(endsAtMs(silence), nowMs, timeZone)}`,
	])

/** The header's "Silence" action, which opens the silence dialog scoped to the page's rule or incident. */
export const silenceButton = <M>(h: HtmlBuilder<M>, onClick: M): Html =>
	button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(onClick)] }, [
		icon(h, "BellSlashIcon"),
		"Silence",
	])
