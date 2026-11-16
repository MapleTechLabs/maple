/**
 * Maple's scale claim, from the Superwall customer story. Every page that
 * states it (compare pages, `/pricing.md`, `/llms.txt`) quotes it from here.
 */
import * as m from "../paraglide/messages.js"
import { absolute } from "./page-markdown"

/** The story is English only, so the link is never locale-prefixed. */
export const SCALE_PROOF_STORY_PATH = "/customers/superwall"

/** The claim plus its source link, for the `.md` twins. */
export const scaleProofMarkdown = (site: URL | undefined): string =>
	`**${m.scale_proof_label()}:** ${m.scale_proof()} [${m.scale_proof_link()}](${absolute(site, SCALE_PROOF_STORY_PATH)})`
