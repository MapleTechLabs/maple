// Installs the whole skills folder: maple-onboard reads its per-language companion skills.
export const ONBOARD_SKILL_COMMAND = "bunx skills add MapleTechLabs/maple/skills --skill '*'"

// The endpoint carries the org's region; the skill uses it verbatim. The prompt is pasted into an
// AI tool, so it carries only the public key: the user sets the private key in their own env.
// Without a public key (still loading, or no access) the skill inlines MAPLE_TEST for the user to swap.
export function onboardSkillPrompt(ingestUrl: string, publicKey: string): string {
	return [
		"Install Maple in this repo using the maple-onboard skill.",
		`My ingest endpoint is ${ingestUrl}.`,
		...(publicKey ? [`My public ingest key for browser and mobile code is ${publicKey}.`] : []),
		"Server code reads my private key from MAPLE_INGEST_KEY, which I set in my environment or .env myself.",
	].join("\n")
}
