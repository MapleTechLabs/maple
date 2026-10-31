// index.html's first module script: its small graph runs while `entry.ts`'s bundle is still
// downloading and evaluating. The OAuth return still leaves the URL before anything reads it.
import "./platform/oauth-return-boot"
import { startClerkBoot } from "./platform/clerk-boot"
// Static on purpose: Chrome holds a dynamic import of a module the app's own graph also imports
// until that whole graph has loaded, which would start the page code no earlier than `init`.
import { startRoutePageCode } from "./page/code"

startClerkBoot()
startRoutePageCode(location.pathname)
