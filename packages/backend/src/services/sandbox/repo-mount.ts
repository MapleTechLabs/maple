/**
 * How a Maple repository checkout is named inside effect-agent's `Sandbox`
 * contract: as the one `SandboxMount` a request carries, whose `source` is
 * `maple-vcs://<orgId>/<owner>/<name>@<ref>`. The tenant rides in the source
 * so the implementation, which sees nothing but the request, can never be
 * pointed at another organization's repository.
 */
import type { OrgId } from "@maple/domain/http"
import {
	NetworkDisabled,
	SandboxImplementation,
	SandboxMount,
	SandboxRuntime,
} from "@effect-agent/sandbox/Sandbox"
import { Option, Schema } from "effect"

export const REPO_SANDBOX_RUNTIME = new SandboxRuntime({
	kind: "container",
	identity: "cloudflare-sandbox",
})

/** Who a refusal comes from, shared by the service and the container implementation. */
export const REPO_SANDBOX_IMPLEMENTATION = new SandboxImplementation({
	isolation: "isolated",
	identity: "cloudflare-sandbox",
})

/** Where the checkout appears inside the container; commands run relative to it. */
export const REPO_MOUNT_TARGET = "/workspace"

export const NETWORK_DISABLED = new NetworkDisabled({})

const SCHEME = "maple-vcs://"

export interface RepoMountSource {
	readonly orgId: OrgId
	readonly repository: string
	/** Branch, tag or SHA; absent means the repository's tracked branch. */
	readonly ref: string | undefined
}

const decodeOrgId = Schema.decodeUnknownOption(Schema.String) // OrgId's brand is applied by the caller's context

export const formatRepoMountSource = (source: RepoMountSource): string =>
	`${SCHEME}${source.orgId}/${source.repository}${source.ref === undefined ? "" : `@${source.ref}`}`

export const parseRepoMountSource = (
	source: string,
): Option.Option<{
	readonly orgId: string
	readonly repository: string
	readonly ref: string | undefined
}> => {
	if (!source.startsWith(SCHEME)) return Option.none()
	const rest = source.slice(SCHEME.length)
	const firstSlash = rest.indexOf("/")
	if (firstSlash <= 0) return Option.none()
	const orgId = rest.slice(0, firstSlash)
	const remainder = rest.slice(firstSlash + 1)
	// owner/name may not contain `@`; a ref may (`v1@2` is a legal tag), so split at the first.
	const at = remainder.indexOf("@")
	const repository = at === -1 ? remainder : remainder.slice(0, at)
	const ref = at === -1 ? undefined : remainder.slice(at + 1)
	if (!/^[^/@\s]+\/[^/@\s]+$/.test(repository) || ref === "") return Option.none()
	if (Option.isNone(decodeOrgId(orgId))) return Option.none()
	return Option.some({ orgId, repository, ref })
}

export const repoMount = (source: RepoMountSource): SandboxMount =>
	new SandboxMount({
		source: formatRepoMountSource(source),
		target: REPO_MOUNT_TARGET,
		access: "read-only",
	})
