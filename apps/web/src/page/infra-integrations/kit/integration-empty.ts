import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { emptyMessage } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { icon, type IconName } from "../../../ui/icon"
import { panel } from "../../../ui/panel"

// `IntegrationEmpty` and its parts and `IntegrationIconPlate`.

export type IntegrationBrand = Readonly<{
	icon: IconName
	/** A monochrome twin for the dimmed backer plates (multicolour marks). */
	backerIcon?: IconName
	accent: string
	/** Monochrome marks: the glyph tints by class and the wash goes neutral. */
	iconClassName?: string
	/** A mark outside the generated set (a chat connector manifest's paths), drawn at `size`. */
	glyph?: (size: number) => Html
	/** The backer plates' mark when `glyph` is set (its monochrome twin). */
	backerGlyph?: (size: number) => Html
}>

export const integrationIconPlate = <M>(
	h: HtmlBuilder<M>,
	brand: IntegrationBrand,
	options: Readonly<{ size?: number; plateClassName?: string; overlay?: Html }> = {},
): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class(
				cn(
					"relative inline-flex shrink-0 items-center justify-center border border-border-subtle bg-card",
					options.plateClassName ?? "size-12 rounded-lg",
				),
			),
			h.Style({ "--tile-accent": brand.accent }),
		],
		[
			h.span([
				h.Class("absolute inset-0 rounded-[inherit] opacity-70"),
				h.Style({
					background:
						brand.iconClassName !== undefined
							? "radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--muted-foreground) 22%, transparent), transparent 70%)"
							: "radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--tile-accent) 16%, transparent), transparent 70%)",
				}),
			]),
			h.span(
				[
					h.Class(cn("relative", brand.iconClassName)),
					...(brand.iconClassName === undefined ? [h.Style({ color: brand.accent })] : []),
				],
				[
					brand.glyph === undefined
						? icon(h, brand.icon, { size: options.size ?? 22 })
						: brand.glyph(options.size ?? 22),
				],
			),
			...(options.overlay === undefined ? [] : [options.overlay]),
		],
	)

export type IntegrationFeature = Readonly<{ label: string; title: string; description: string }>

/** `IntegrationEmptyFeatures` with one `IntegrationEmptyFeature` per entry. */
export const integrationEmptyFeatures = <M>(
	h: HtmlBuilder<M>,
	features: ReadonlyArray<IntegrationFeature>,
): Html =>
	h.ul(
		[h.Class("grid grid-cols-1 gap-3 text-left @2xl/page:grid-cols-3")],
		features.map((feature, index) =>
			h.li(
				[
					h.Class(
						"flex animate-in fade-in slide-in-from-bottom-1 [animation-duration:300ms] motion-reduce:animate-none",
					),
					h.Style({
						"animation-delay": `${50 + index * 50}ms`,
						"animation-fill-mode": "backwards",
					}),
				],
				[
					panel(h, { className: "flex-1 gap-2 border-border-subtle px-4 py-3.5" }, [
						eyebrow(h, { variant: "label" }, [feature.label]),
						h.span([h.Class("text-base/5 font-semibold tracking-tight")], [feature.title]),
						h.p([h.Class("text-xs/4 text-muted-foreground")], [feature.description]),
					]),
				],
			),
		),
	)

const BACKER =
	"absolute bottom-0.5 flex size-11 items-center justify-center rounded-xl-inset border border-border-subtle bg-muted text-foreground-subtle opacity-80"

/** `IntegrationEmptyMedia`: two dim backer plates fanned behind the brand plate. */
export const integrationEmptyMedia = <M>(h: HtmlBuilder<M>, brand: IntegrationBrand): Html => {
	const backerIcon = brand.backerIcon ?? brand.icon
	return h.div(
		[h.AriaHidden(true), h.Class("relative mb-1 flex h-16 shrink-0 items-end justify-center")],
		[
			h.span(
				[h.Class(cn(BACKER, "origin-bottom -translate-x-8 -rotate-10"))],
				[brand.backerGlyph === undefined ? icon(h, backerIcon, { size: 20 }) : brand.backerGlyph(20)],
			),
			h.span(
				[h.Class(cn(BACKER, "origin-bottom translate-x-8 rotate-10"))],
				[brand.backerGlyph === undefined ? icon(h, backerIcon, { size: 20 }) : brand.backerGlyph(20)],
			),
			integrationIconPlate(h, brand, {
				size: 28,
				plateClassName: "relative size-14 rounded-xl shadow-popup shadow-black/10",
			}),
		],
	)
}

/** `IntegrationEmptyCard`: the dashed waiting-room card. */
export const integrationEmptyCard = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html>,
	className?: string,
): Html =>
	emptyMessage(
		h,
		{
			dashed: true,
			className: cn(
				"flex min-h-70 flex-col items-center justify-center gap-4 border-input px-6 py-10",
				className,
			),
		},
		children,
	)

export const integrationEmptyHint = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
	h.p([h.Class("max-w-xl text-balance text-sm text-muted-foreground")], children)

export const integrationEmptyFooter = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
	h.p([h.Class("text-xs text-muted-foreground")], children)

/** `IntegrationEmpty`: the feature row, then the card. */
export const integrationEmpty = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html>,
	className?: string,
): Html => h.div([h.Class(cn("flex flex-col gap-4", className))], children)

export type IntegrationConnectCtaOptions = Readonly<{
	brand: IntegrationBrand
	features: ReadonlyArray<IntegrationFeature>
	hint: string
	/** "Connect Railway". */
	label: string
	/** The connect flow, opened at the source's Connect step (`/sources/new?integration=`). */
	href: string
}>

/** An infra page with nothing connected: what it will show, and one way to the connect flow. */
export const integrationConnectCta = <M>(h: HtmlBuilder<M>, options: IntegrationConnectCtaOptions): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, options.features),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, options.brand),
			integrationEmptyHint(h, [options.hint]),
			linkButton(h, { href: options.href }, [options.label, icon(h, "ArrowRightIcon", { size: 14 })]),
		]),
	])
