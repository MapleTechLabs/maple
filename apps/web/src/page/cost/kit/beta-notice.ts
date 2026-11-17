import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { icon } from "@maple/views/ui/icon"
import type { Html, HtmlBuilder } from "foldkit/html"

/** The Cloud cost pages' note that the beta is free, above each page's body. */
export const betaNotice = <M>(h: HtmlBuilder<M>): Html =>
	alert(h, { variant: "info", size: "sm", role: "status" }, [
		icon(h, "TagIcon"),
		alertTitle(h, ["Free during the beta"]),
		alertDescription(h, [
			"Cloud cost is free while it is in beta. We will tell you before that changes.",
		]),
	])
