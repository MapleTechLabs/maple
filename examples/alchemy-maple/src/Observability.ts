import { Local } from "@maple-dev/alchemy/local"

// One declaration, shared by both Workers. Storage is isolated under .alchemy.
export const Observability = Local("observability")
