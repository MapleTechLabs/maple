// Installs the whole skills folder: maple-onboard reads its per-language companion skills.
export const ONBOARD_SKILL_COMMAND = "bunx skills add MapleTechLabs/maple/skills --skill '*'"

// The endpoint carries the org's region; the skill uses it verbatim.
export function onboardSkillPrompt(ingestUrl: string, ingestKey: string): string {
	return [
		"Install Maple in this repo using the maple-onboard skill.",
		`My ingest endpoint is ${ingestUrl}.`,
		`My ingest key is ${ingestKey || "<your-ingest-key>"}.`,
	].join("\n")
}
