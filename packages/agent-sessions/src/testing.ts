// Span builders for tests and the synthetic session behind `/lab/agent-session`.
// Behind its own subpath, so only the lab route and the tests pull the fixture in.

export * from "./span-test-support"
export * from "./agent-session-fixture"
