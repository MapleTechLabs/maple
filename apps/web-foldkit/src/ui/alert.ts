import { cn } from "@maple/ui/lib/utils"
import {
	alertActionStyles,
	alertDescriptionStyles,
	alertTitleStyles,
	alertVariants,
} from "@maple/ui/styles/ui/alert"
import type { VariantProps } from "class-variance-authority"
import type { Html, HtmlBuilder } from "foldkit/html"

type Children = ReadonlyArray<Html | string>

export type AlertOptions = VariantProps<typeof alertVariants> & Readonly<{ className?: string }>

/** `<Alert>`: `role="alert"` with the same `alertVariants` composition. */
export const alert = <Message>(h: HtmlBuilder<Message>, options: AlertOptions, children: Children): Html =>
	h.div(
		[
			h.Class(cn(alertVariants({ size: options.size, variant: options.variant }), options.className)),
			h.DataAttribute("slot", "alert"),
			h.Role("alert"),
		],
		children,
	)

export const alertTitle = <Message>(h: HtmlBuilder<Message>, children: Children): Html =>
	h.div([h.Class(cn(alertTitleStyles)), h.DataAttribute("slot", "alert-title")], children)

export const alertDescription = <Message>(h: HtmlBuilder<Message>, children: Children): Html =>
	h.div([h.Class(cn(alertDescriptionStyles)), h.DataAttribute("slot", "alert-description")], children)

export const alertAction = <Message>(h: HtmlBuilder<Message>, children: Children): Html =>
	h.div([h.Class(cn(alertActionStyles)), h.DataAttribute("slot", "alert-action")], children)
