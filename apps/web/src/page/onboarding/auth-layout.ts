import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// `<AuthLayout>`: the centred brand card of the signed-out and interstitial screens (CLI login, MCP consent,
// unsubscribe, org required).

const GRID_STYLE = {
	"background-image": [
		"linear-gradient(to right, oklch(0.91 0.016 74 / 8%) 1px, transparent 1px)",
		"linear-gradient(to bottom, oklch(0.91 0.016 74 / 8%) 1px, transparent 1px)",
	].join(", "),
	"background-size": "60px 60px",
	"mask-image": "radial-gradient(ellipse 70% 60% at 50% 40%, black, transparent)",
}

const GLOW_STYLE = {
	width: "600px",
	height: "400px",
	top: "50%",
	left: "50%",
	transform: "translate(-50%, -50%)",
	background:
		"radial-gradient(ellipse at center, oklch(0.714 0.154 59 / 0.12) 0%, oklch(0.714 0.154 59 / 0.04) 40%, transparent 70%)",
}

export const authLayout = <M>(h: HtmlBuilder<M>, maxWidth: string, children: ReadonlyArray<Html>): Html =>
	h.main(
		[
			h.Class(
				"relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-10 sm:p-6",
			),
		],
		[
			h.div(
				[h.Class("pointer-events-none absolute inset-0 -z-10 hidden sm:block"), h.Style(GRID_STYLE)],
				[],
			),
			h.div([h.Class("absolute -z-10 pointer-events-none"), h.Style(GLOW_STYLE)], []),
			h.p([h.Class("mb-6 text-lg font-semibold tracking-tight text-foreground")], ["maple"]),
			h.div(
				[h.Class(`relative w-full ${maxWidth} sm:border sm:border-border sm:bg-card sm:p-6`)],
				children,
			),
		],
	)

/** `AuthLayout.Title`. */
export const authTitle = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html | string>,
	className?: string,
): Html => h.h1([h.Class(cn("text-xl font-semibold", className))], children)

/** `AuthLayout.Description`. */
export const authDescription = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html | string>,
	className?: string,
): Html => h.p([h.Class(cn("mt-2 text-sm text-muted-foreground", className))], children)
