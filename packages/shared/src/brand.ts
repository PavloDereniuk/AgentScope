/**
 * Phantom-type branding for nominal-style primitives.
 * The brand symbol is exported so consumer modules can reference the
 * resulting types in their `.d.ts` outputs (composite project mode).
 */

export declare const brandSym: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brandSym]: B };
