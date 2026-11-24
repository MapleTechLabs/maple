# Roles, permissions and custom roles

## How it works

- Every check reads a permission, never a role. The catalog, built-in role presets and custom role
  storage live in `packages/domain/src/policy/` (`permissions.ts`, `roles.ts`, `custom-roles.ts`;
  `index.ts` has `grantsOf`, `can`, `check`, `denialFor`).
- Built-in roles are Clerk roles: `org:analyst`, `org:member`, `org:engineer`, `org:admin`.
- A custom role is stored in Clerk, not Postgres:
    - definitions in the organization's public metadata, key `maple_roles`, versioned;
    - a member on one holds the Clerk role `org:custom`, and their membership's public metadata
      (`maple_role`) holds the role id and a copy of its permission codes.
- Only Maple's backend writes either (`RolesService`, `ClerkRolesGateway`). `org:custom` with
  nothing on the membership holds no permissions; it can still open settings pages that need none.
- Enforcement: `EndpointAccess` on HTTP endpoints (`packages/domain/src/http/endpoint-access.ts`),
  `permission` on MCP tools, and `MembershipRevocationService.demoteMembership` retiring
  credentials, links, digests and phones a narrower role no longer covers.

## Clerk instance requirements

- Role `org:custom` exists, is in each organization's role set, and holds only
  `org:sys_memberships:read`.
- `org:engineer` and `org:analyst` hold no `org:sys_memberships:manage`: members are changed
  through Maple, which keeps custom role metadata in step.
- Production needs Clerk's B2B Authentication add-on for custom roles.
- The `organizationMembership.*` webhook events are enabled (`/webhooks/clerk`): they demote
  pinned credentials and evict cached memberships.
- Change roles in Maple, not in the Clerk dashboard. A member set back to `org:custom` by hand is
  checked by the webhook against the role their `maple_role` names: a deleted role leaves them with
  nothing and a narrowed one with its current permissions.

## Known limits

- Every role write in Maple holds a per-org Postgres advisory lock (`RoleWriteLock`), so two admins
  saving at once take turns. A change made in the Clerk dashboard in between is still possible:
  writes stay version-checked, and the holder reconcile repeats until holders match the latest
  stored definition (three passes, then `concurrent_edit`).
- A holder Clerk refuses to rewrite does not stop the others; the save then fails with
  `roles_unavailable`, and sending the same save again finishes the remaining holders.
- Membership answers are cached up to 5 minutes (shared) and 60 s (per isolate). A narrowing
  evicts the shared entry and the handling isolate's memo; other isolates keep the old permissions
  up to 60 s, and everything up to 5 minutes if the eviction never ran.
- Escalation steps page whoever they name, regardless of that person's permissions.
- Every permission implies Read telemetry unless it is marked `readsNoTelemetry` (billing, own
  devices, MCP and restricted keys, the support channel, status page updates, the public ingest
  key). A role without Read telemetry is for those jobs only.
- PR review replies on a private repository answer anyone who can comment there, with telemetry
  tools: repository access is the gate, not the commenter's Maple role.
