// Everything the Agent Sessions detail view derives from a session's spans, with no
// rendering attached: turns, summary, findings, transcript rows and per-span detail.
// The page and the MCP read the same model, so the two can never describe a session
// differently.

export * from "./session-turns"
export * from "./session-summary"
export * from "./session-findings"
export * from "./session-transcript"
export * from "./span-detail"

// Test-only span builders and the synthetic session behind `/lab/agent-session`. They
// live here because they build `AiSessionSpan`s against the same domain schema the
// derivations read, and the web lab and the package's own tests both use them.
export * from "./span-test-support"
export * from "./agent-session-fixture"
