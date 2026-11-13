import * as Policy from "@maple/domain/policy"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"

type Grants = Readonly<{ grants: ReadonlyArray<Policy.Permission> }>

/** An errors page's grants on entry: none until the session answers, all when self-hosted. */
export const initialGrants: ReadonlyArray<Policy.Permission> = isClerkAuthEnabled ? [] : Policy.allPermissions

/** The session is only read where there is one; self-hosted mode holds every permission. */
export const readsSessionGrants = isClerkAuthEnabled

/** The viewer may move, claim, rate, merge, link and comment on issues (`error_issues:triage`). */
export const canTriageIssues = (model: Grants): boolean => Policy.has(model.grants, "error_issues:triage")
