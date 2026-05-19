// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { Registry, RegistryContext } from "@/lib/effect-atom"
import { AttributesTable } from "./attributes-table"

function createWrapper() {
	const registry = Registry.make()
	return function Wrapper({ children }: { children: ReactNode }) {
		return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
	}
}

afterEach(() => cleanup())

const renderTable = (attributes: Record<string, string>, opts: { title?: string } = {}) => {
	const Wrapper = createWrapper()
	return render(
		<Wrapper>
			<AttributesTable attributes={attributes} title={opts.title ?? "Attributes"} />
		</Wrapper>,
	)
}

describe("AttributesTable — commit-SHA auto-detection", () => {
	it("renders deployment.commit_sha value as a CommitChip (truncated)", () => {
		const sha = "abc1234567890def1234567890abcdef"
		renderTable({ "deployment.commit_sha": sha })
		// short SHA (7 chars) appears, not the full SHA, because CommitChip truncates
		expect(screen.getByText("abc1234")).toBeTruthy()
		// The full SHA should NOT be in the text content (only as a copy target / aria)
		const fullShaExactMatches = screen.queryAllByText(sha)
		expect(fullShaExactMatches.length).toBe(0)
	})

	it.each([
		"git.commit.sha",
		"git.commit.id",
		"vcs.repository.change.id",
		"commit_sha",
		"commit.sha",
		"commit",
	])("detects '%s' as a commit-SHA key", (key) => {
		const sha = "0123456789abcdef0123456789abcdef01234567"
		renderTable({ [key]: sha })
		expect(screen.getByText("0123456")).toBeTruthy()
	})

	it("falls back to plain text when key is NOT a commit-SHA key", () => {
		// `service.name` is not in the SHA-key list, even if value looks like hex
		renderTable({ "service.name": "abc1234567890def" })
		expect(screen.getByText("abc1234567890def")).toBeTruthy()
	})

	it("falls back to plain text when value is not a valid SHA shape", () => {
		// Key matches but value is too short / has wrong chars
		renderTable({ "deployment.commit_sha": "v1.2.3" })
		expect(screen.getByText("v1.2.3")).toBeTruthy()
	})

	it("renders an unrelated attribute as plain text", () => {
		renderTable({ "http.method": "POST" })
		expect(screen.getByText("POST")).toBeTruthy()
	})

	it("renders attribute key alongside the chip", () => {
		const sha = "deadbeef0000000000000000000000000000abcd"
		renderTable({ "deployment.commit_sha": sha })
		expect(screen.getByText("deployment.commit_sha")).toBeTruthy()
		expect(screen.getByText("deadbee")).toBeTruthy()
	})

	it("renders empty-state when no attributes given", () => {
		const Wrapper = createWrapper()
		render(
			<Wrapper>
				<AttributesTable attributes={{}} title="Resource Attributes" />
			</Wrapper>,
		)
		expect(screen.getByText(/No resource attributes available/i)).toBeTruthy()
	})
})
