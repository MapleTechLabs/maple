const authMode = import.meta.env.VITE_MAPLE_AUTH_MODE?.trim().toLowerCase()

const mapleAuthMode = authMode === "clerk" ? "clerk" : "self_hosted"
export const isClerkAuthEnabled = mapleAuthMode === "clerk"
