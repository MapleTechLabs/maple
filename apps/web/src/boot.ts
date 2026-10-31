// index.html's first module script: its small graph runs while `entry.ts`'s bundle is still
// downloading and evaluating. The OAuth return still leaves the URL before anything reads it.
import "./platform/oauth-return-boot"
import { startClerkBoot } from "./platform/clerk-boot"

startClerkBoot()
