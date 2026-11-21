/**
 * Runs before `alchemy:deploy:prd`: production deploys come from the CI workflow, never a laptop.
 * Break glass with MAPLE_PRD_DEPLOY_BREAK_GLASS="<why>"; see docs/infra.md.
 */
import { BREAK_GLASS_ENV, decidePrdDeploy } from "./lib/prd-deploy-guard.ts"

const decision = decidePrdDeploy(process.env)
if (decision.kind === "refused") {
	console.error(
		[
			"✗ Refusing to deploy production outside CI.",
			"  Production deploys run from the deploy-prd-instance workflow (CI=true, GITHUB_ACTIONS=true).",
			`  Break glass only in an incident: ${BREAK_GLASS_ENV}="<reason>" bun run alchemy:deploy:prd`,
		].join("\n"),
	)
	process.exit(1)
}
if (decision.kind === "break_glass") {
	const bar = "!".repeat(72)
	console.warn(
		[
			bar,
			"!! BREAK GLASS: deploying PRODUCTION from outside CI.",
			`!! Reason: ${decision.reason}`,
			"!! Tell the team now and record this deploy in the incident channel.",
			bar,
		].join("\n"),
	)
}
