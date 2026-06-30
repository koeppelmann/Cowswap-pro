// Selection shared between the Swap and TWAP tabs so switching tabs keeps the
// chosen tokens + amount. Only plain tokens are carried — a selected leverage
// position is never written here (TWAP can't sell a position).
export type TokLite = { address: string; symbol: string; decimals: number };
export type SharedSel = { sell?: TokLite; buy?: TokLite; amount?: string };
