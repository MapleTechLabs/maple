import type { TestProject } from "vitest/node"
import { buildPgliteSnapshot, snapshotPath } from "./pglite-snapshot"

/**
 * Runs once per `vitest` invocation, before any worker forks. Building the
 * schema snapshot here rather than lazily in a worker means the ~0.5s initdb +
 * migrate is paid exactly once instead of once per worker process.
 */
export const setup = async (project: TestProject): Promise<void> => {
	await buildPgliteSnapshot()
	project.provide("pgliteSnapshot", snapshotPath)
}
