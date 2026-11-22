import { Array as Arr } from "effect"

// The coding-agent prompts that point at the setup guides maple.dev serves.

/** The agent setup guide maple.dev serves (`skills/maple-onboard/SKILL.md`). */
export const AGENT_SETUP_GUIDE_URL = "https://maple.dev/SKILL.md"

/** The Users page's empty state prompt: the `maple-identify-users` skill, served by maple.dev. */
export const IDENTIFY_USERS_PROMPT =
	"Identify the signed-in users in my app so they show up on Maple's Users page: maple.dev/skills/identify-users.md"

/** The handoff line's label; the code after it signs the agent's `maple` CLI in once. */
export const HANDOFF_LINE_LABEL = "Handoff code (single use, 15 min):"

/** What the page shows in place of a handoff code: the real one exists only once Copy mints it. */
export const MASKED_HANDOFF_CODE = "••••••••••"

/**
 * The one coding-agent setup prompt. The endpoint carries the org's region; `publicKey` must be the
 * public `maple_pk_` key (it lands in an agent's context). Empty key or handoff code leaves its line out.
 */
export function agentSetupPrompt(ingestUrl: string, publicKey: string, handoffCode = ""): string {
	return Arr.join(
		[
			`Set up Maple observability in this repo by following ${AGENT_SETUP_GUIDE_URL}`,
			`Ingest endpoint: ${ingestUrl}`,
			...(publicKey === "" ? [] : [`Public ingest key: ${publicKey}`]),
			...(handoffCode === "" ? [] : [`${HANDOFF_LINE_LABEL} ${handoffCode}`]),
		],
		"\n",
	)
}
