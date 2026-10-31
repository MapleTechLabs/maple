// Maple's declarations for the upstream validator (not part of the upstream skill).
export declare const LIMITS: { readonly inputBytes: number; readonly units: number; readonly validationErrors: number }
export declare function validateDocument(ledger: unknown): Array<string>
export declare function canonicalCoverageId(refs: unknown): string
export declare function encodeCanonicalRef(value: string): string
export declare function isSafeAgentId(value: unknown): boolean
export declare function isSafeRelativePath(value: unknown): boolean
