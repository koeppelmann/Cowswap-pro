# UX review & improvement plan

## Problems (see issues 1–14 in chat) — root causes
- **Everything is on one screen.** Config + limits + per-part recap + prices + approve/deploy + recovery
  are all stacked, so the page is a wall of repeated numbers. CoW keeps the main screen minimal and
  pushes detail into a review step.
- **No single primary action.** "Review TWAP" (dead) + Approve + Deploy + Export + Record = 5 buttons,
  unclear path.
- **Power features shown by default** (3-way limit controls, recovery, manual deploy).
- **Precision/format noise** and integer-division artifacts ("999.999999").

## Plan

### Phase 1 — Declutter to one flow (highest impact)
1. **One recap, not three.** Keep a single compact summary (per-part sell, est. receive, schedule).
   Move the full Prices table + min-in-every-unit behind a collapsible **"Details ▾"**. Remove the
   duplicate limit displays.
2. **Hide advanced limits.** Default: just **Price protection: 0.5%**. An **"Advanced ▾"** reveals
   min-price / min-receive (still 3-way bound). Most users only touch slippage.
3. **One state-aware primary CTA.** Replace the dead "Review TWAP" with a button that performs the
   next real step: Connect → Select tokens → Enter amount → **Insufficient balance** → Too-short →
   **Approve & start**. Approving is the only action a user needs; the **relayer auto-deploys**.
   Demote manual "Deploy" to an "advanced / it didn't auto-deploy?" fallback.
4. **Number formatting.** Show ~5 significant figures (e.g. 868.89, 0.86454), full value on hover.
   Fix the approve/total to read **1,000** (approve the exact pulled amount but display rounded;
   or distribute the remainder so n·partSell == total).
5. **Step numbering / structure.** Either drop the "3 ·" or label 1·Trade / 2·Schedule & price /
   3·Approve consistently — but ideally collapse to a single card + a review/confirm step.

### Phase 2 — Clarity & guidance
6. **Explain the Safe + auto-deploy inline:** "We create your personal Safe that runs the order.
   Approve once — your tokens move only when it deploys (automatically), and you can revoke anytime."
7. **Recipient as a chip:** "Recipient: your wallet ✎" → expands to edit, instead of a greyed address.
8. **Auto-deploy status:** after Approve, show "Approved ✓ — deploying automatically…" tracking the
   relayer; surface manual Deploy only if it stalls > ~30s.
9. **Stale-approval guard:** if an allowance exists to a *previous* config's safe, warn
   "you approved a different configuration — approve this one".
10. **Recovery → advanced/optional**, with one line on when it matters (re-deploying a pending order; with the allowance model funds are never stranded).
11. **"vs market"**: only show when |Δ| > 0.1%, with a tooltip ("TWAP expects to beat a single swap by …").

### Phase 3 — Robustness / ops
12. **Cache-busting / version badge** (build hash in footer) so stale bundles are obvious; an atomic
    `restart.sh` (kill→build→start) to end the orphaned-server problem.
13. **Quote states:** skeleton while loading, clear error ("no route / illiquid"), stale indicator.
14. **Confirm modal** (CoW-style) for the final review instead of a long inline panel.

### Phase 4 — Polish
15. Mobile pass + a11y; consistent ⇄ flip across all rates; optional light "paper" theme.

## Suggested order
Phase 1 (1–5) first — it removes ~70% of the confusion with low risk. Then 6–9 (clarity), then ops/polish.
