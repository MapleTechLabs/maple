/**
 * What the Enterprise plan adds, in one line. The compare pages, `/pricing.md`
 * and `/llms.txt` quote it from here.
 */
import * as m from "../paraglide/messages.js"
import { absolute } from "./page-markdown"

/** The claim plus a link to pricing, for the `.md` twins. */
export const enterpriseOfferMarkdown = (site: URL | undefined): string =>
	`**${m.enterprise_offer_label()}:** ${m.enterprise_offer()} [${m.enterprise_offer_link()}](${absolute(site, "/pricing")})`
