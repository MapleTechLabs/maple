// Single source of truth lives in @maple/codemode so the apps/api + apps/chat-flue
// copies can't drift. Re-exported here to keep existing `./mutating` imports stable.
// The fail-closed regression test lives in `./mutating.test.ts`.
export { MUTATING_TOOL_NAMES } from "@maple/codemode"
