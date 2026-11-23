---
"@maple/cli": minor
---

Your coding agent can now set Maple up for you. Copy the agent prompt on the dashboard's connect step: it carries a single-use handoff code that signs the CLI in once (`MAPLE_API_URL=<api> MAPLE_HANDOFF=<code> maple auth login`, or the same variables on the install script). `maple onboarding report <stage> <status>` shows the agent's progress on the connect step, `maple onboarding keys` prints the ingest endpoint and public key, and `maple onboarding verify --service <name> --env <environment>` waits for a trace from that service and environment.
