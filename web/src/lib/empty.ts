/** Stable empty array so `data ?? EMPTY` does not create a new dependency on every render. */
export const EMPTY: never[] = [];
