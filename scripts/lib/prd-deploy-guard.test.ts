import { describe, expect, test } from "bun:test"
import { decidePrdDeploy } from "./prd-deploy-guard.ts"

describe("decidePrdDeploy", () => {
	test("GitHub Actions deploys without a prompt", () => {
		expect(decidePrdDeploy({ CI: "true", GITHUB_ACTIONS: "true" })).toEqual({ kind: "ci" })
	})

	test("a laptop is refused, even one that claims CI without GitHub Actions", () => {
		expect(decidePrdDeploy({})).toEqual({ kind: "refused" })
		expect(decidePrdDeploy({ CI: "true" })).toEqual({ kind: "refused" })
		expect(decidePrdDeploy({ CI: "1", GITHUB_ACTIONS: "true" })).toEqual({ kind: "refused" })
	})

	test("break glass needs a non-blank reason", () => {
		expect(decidePrdDeploy({ MAPLE_PRD_DEPLOY_BREAK_GLASS: "  " })).toEqual({ kind: "refused" })
		expect(decidePrdDeploy({ MAPLE_PRD_DEPLOY_BREAK_GLASS: "ci outage, hotfix #1" })).toEqual({
			kind: "break_glass",
			reason: "ci outage, hotfix #1",
		})
	})
})
