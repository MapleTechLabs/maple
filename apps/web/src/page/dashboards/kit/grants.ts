import * as Policy from "@maple/domain/policy"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"

type Grants = Readonly<{ grants: ReadonlyArray<Policy.Permission> }>

/** A dashboards page's grants on entry: none until the session answers, all when self-hosted. */
export const initialGrants: ReadonlyArray<Policy.Permission> = isClerkAuthEnabled ? [] : Policy.allPermissions

/** The session is only read where there is one; self-hosted mode holds every permission. */
export const readsSessionGrants = isClerkAuthEnabled

/** The viewer may create, edit, duplicate, import, restore and delete dashboards (`dashboards:edit`). */
export const canEditDashboards = (model: Grants): boolean => Policy.has(model.grants, "dashboards:edit")

/** The viewer may share a dashboard or embed a widget outside the org (`dashboards:share`). */
export const canShareDashboards = (model: Grants): boolean => Policy.has(model.grants, "dashboards:share")
