import { AuditTrailProvider } from "@maple/domain/audit-trail"
import { cn } from "@maple/ui/lib/utils"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import type { IntegrationBrand } from "../../kit/integration-empty"
import { PROVIDERS } from "../../kit/providers"
import { providerLabel } from "./audit-labels"

// Each audit platform's mark, shared by the sources panel and the event list.

const BRANDS = {
	maple: { icon: "MapleMark", accent: "var(--color-brand-maple)" },
	vercel: PROVIDERS.vercel,
	gcp: PROVIDERS.gcp,
	aws: PROVIDERS.aws,
} satisfies Record<AuditTrailProvider, IntegrationBrand>

/** A platform a newer writer added gets a neutral history mark. */
const UNKNOWN_BRAND: IntegrationBrand = {
	icon: "HistoryIcon",
	accent: "var(--primary)",
	iconClassName: "text-muted-foreground",
}

const isProvider = Schema.is(AuditTrailProvider)

export const providerBrand = (provider: string): IntegrationBrand =>
	isProvider(provider) ? BRANDS[provider] : UNKNOWN_BRAND

/** The platform's bare mark, tinted like its plate. */
export const providerMark = <M>(h: HtmlBuilder<M>, provider: string, size = 14): Html => {
	const brand = providerBrand(provider)
	return h.span(
		[
			h.AriaHidden(true),
			h.Class(cn("inline-flex shrink-0", brand.iconClassName)),
			...(brand.iconClassName === undefined ? [h.Style({ color: brand.accent })] : []),
		],
		[brand.glyph === undefined ? icon(h, brand.icon, { size }) : brand.glyph(size)],
	)
}

/** The platform's mark beside its name. */
export const providerName = <M>(h: HtmlBuilder<M>, provider: string): Html =>
	hstack(h, { gap: "2", align: "center", className: "min-w-0" }, [
		providerMark(h, provider),
		typography(h, { truncate: true }, [providerLabel(provider)]),
	])
