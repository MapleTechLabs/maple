/** Set to a reason to deploy production from outside CI. Every use prints a loud warning. */
export const BREAK_GLASS_ENV = "MAPLE_PRD_DEPLOY_BREAK_GLASS"

export type PrdDeployDecision =
	| { readonly kind: "ci" }
	| { readonly kind: "break_glass"; readonly reason: string }
	| { readonly kind: "refused" }

/** Production deploys run in GitHub Actions; anywhere else needs an explicit break-glass reason. */
export const decidePrdDeploy = (env: Readonly<Record<string, string | undefined>>): PrdDeployDecision => {
	if (env["CI"] === "true" && env["GITHUB_ACTIONS"] === "true") return { kind: "ci" }
	const reason = env[BREAK_GLASS_ENV]?.trim() ?? ""
	return reason === "" ? { kind: "refused" } : { kind: "break_glass", reason }
}
