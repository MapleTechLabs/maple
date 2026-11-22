import { Array as Arr } from "effect"

// The coding-agent prompts that point at the setup guides maple.dev serves.

/** The agent setup guide maple.dev serves (`skills/maple-onboard/SKILL.md`). */
export const AGENT_SETUP_GUIDE_URL = "https://maple.dev/SKILL.md"

/** The Users page's empty state prompt: the `maple-identify-users` skill, served by maple.dev. */
export const IDENTIFY_USERS_PROMPT =
	"Identify the signed-in users in my app so they show up on Maple's Users page: maple.dev/skills/identify-users.md"

/**
 * The one coding-agent setup prompt. The endpoint carries the org's region; `publicKey` must be the
 * public `maple_pk_` key (it lands in an agent's context), and its line is left out when empty.
 */
export function agentSetupPrompt(ingestUrl: string, publicKey: string): string {
	return Arr.join(
		[
			`Set up Maple observability in this repo by following ${AGENT_SETUP_GUIDE_URL}`,
			`Ingest endpoint: ${ingestUrl}`,
			...(publicKey === "" ? [] : [`Public ingest key: ${publicKey}`]),
		],
		"\n",
	)
}
