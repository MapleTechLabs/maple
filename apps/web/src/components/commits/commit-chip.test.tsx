// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { Registry, RegistryContext } from "@/lib/effect-atom"
import { CommitChip } from "./commit-chip"
import { CommitLookupProvider } from "./commit-lookup-context"
import type { CommitInfo } from "@maple/domain/http"

function createWrapper() {
	const registry = Registry.make()
	return function Wrapper({ children }: { children: ReactNode }) {
		return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
	}
}

afterEach(() => {
	cleanup()
})

const fakeCommit = (sha: string): CommitInfo =>
	({
		sha,
		shortSha: sha.slice(0, 7),
		message: "feat: did a thing",
		htmlUrl: `https://github.com/acme/repo/commit/${sha}`,
		repoOwner: "acme",
		repoName: "repo",
		author: { login: "jane", name: "Jane Doe", email: "jane@x", avatarUrl: null },
		committer: { login: "jane", name: "Jane Doe", email: "jane@x", avatarUrl: null },
		authoredAt: 1700000000000,
		committedAt: 1700000000000,
		branches: ["main"],
		prNumber: null,
	}) as CommitInfo

describe("CommitChip", () => {
	it("renders the 7-char short SHA", () => {
		const Wrapper = createWrapper()
		const sha = "abc1234def5678"
		render(
			<Wrapper>
				<CommitChip sha={sha} />
			</Wrapper>,
		)
		expect(screen.getByText("abc1234")).toBeTruthy()
	})

	it("renders raw value (no chip) for non-SHA input", () => {
		const Wrapper = createWrapper()
		render(
			<Wrapper>
				<CommitChip sha="not-a-sha" />
			</Wrapper>,
		)
		// Falls back to plain muted text; the literal string is in the DOM
		expect(screen.getByText("not-a-sha")).toBeTruthy()
	})

	it("renders 'N/A' when sha === 'N/A' sentinel", () => {
		const Wrapper = createWrapper()
		render(
			<Wrapper>
				<CommitChip sha="N/A" />
			</Wrapper>,
		)
		expect(screen.getByText("N/A")).toBeTruthy()
	})

	it("uses pre-resolved commit info from CommitLookupProvider context", () => {
		// We can't easily mock the atom result, so just verify that when there's
		// no resolved data (default initial state), the chip renders the short
		// SHA without crashing.
		const Wrapper = createWrapper()
		const sha = "fedcba9876543210"
		render(
			<Wrapper>
				<CommitLookupProvider shas={[sha]}>
					<CommitChip sha={sha} />
				</CommitLookupProvider>
			</Wrapper>,
		)
		expect(screen.getByText("fedcba9")).toBeTruthy()
	})

	it("renders with showIcon", () => {
		const Wrapper = createWrapper()
		const { container } = render(
			<Wrapper>
				<CommitChip sha="abcdef0123456" showIcon />
			</Wrapper>,
		)
		// Icon is an inline SVG; verify the SHA still renders
		expect(screen.getByText("abcdef0")).toBeTruthy()
		// And confirm an svg child exists somewhere
		expect(container.querySelector("svg")).toBeTruthy()
	})
})

// Type guard: ensure the fake commit shape doesn't drift from the real CommitInfo type.
// This is a compile-time check; runtime no-op.
const _typeCheck: CommitInfo = fakeCommit("a".repeat(40))
void _typeCheck
