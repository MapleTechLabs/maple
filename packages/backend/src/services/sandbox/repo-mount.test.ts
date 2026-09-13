import { assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { formatRepoMountSource, parseRepoMountSource, repoMount } from "./repo-mount"

const ORG = Schema.decodeUnknownSync(OrgId)("org_mount_test")

describe("the repository mount source", () => {
	it("round-trips an org, repository and ref", () => {
		const source = formatRepoMountSource({ orgId: ORG, repository: "octo/shop", ref: "release/v1@2" })
		assert.strictEqual(source, "maple-vcs://org_mount_test/octo/shop@release/v1@2")
		assert.deepStrictEqual(
			parseRepoMountSource(source),
			Option.some({ orgId: "org_mount_test", repository: "octo/shop", ref: "release/v1@2" }),
		)
	})

	it("leaves the ref absent when none was given", () => {
		const parsed = parseRepoMountSource(
			formatRepoMountSource({ orgId: ORG, repository: "octo/shop", ref: undefined }),
		)
		assert.deepStrictEqual(
			parsed,
			Option.some({ orgId: "org_mount_test", repository: "octo/shop", ref: undefined }),
		)
	})

	it("rejects anything that is not one org and one owner/name", () => {
		for (const source of [
			"github://o/octo/shop",
			"maple-vcs://octo/shop",
			"maple-vcs:///octo/shop",
			"maple-vcs://o/octo",
			"maple-vcs://o/octo/shop@",
			"maple-vcs://o/octo/shop/extra",
		]) {
			assert.isTrue(Option.isNone(parseRepoMountSource(source)), source)
		}
	})

	it("mounts read-only at the workspace target", () => {
		const mount = repoMount({ orgId: ORG, repository: "octo/shop", ref: undefined })
		assert.strictEqual(mount.target, "/workspace")
		assert.strictEqual(mount.access, "read-only")
	})
})
