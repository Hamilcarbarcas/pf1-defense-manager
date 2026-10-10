# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## Unreleased

### Added
- **Defense Override.** A new entry type that weakens the creature's own defenses against every
  attack: DR, ER, or Hardness **Bypass** (ignore that defense, optionally only up to a maximum) and
  DR, ER, or Hardness **Reduction** (lower it by an amount). A DR Bypass treats attacks as having
  that type, so DR 10/magic and good becomes DR 10/magic, and DR 10/good or silver disappears. The
  actor sheet and damage dialog show the weakened values. Built for a paladin's Aura of Faith,
  shared to nearby enemies.
- **Defenses are authored on items, not on the actor.** A **Granted Defenses** section on the
  **Advanced** tab of any buff, feat, class feature, racial trait, equipment, weapon or attack holds
  as many entries as the item needs, one tab each. The module owns the actor's native trait fields
  outright and rebuilds them from every active item, so a defense arrives and leaves with the thing
  that grants it instead of being typed onto the sheet and remembered.
- **Seven categories**, six of which land in a native PF1 field:
  - **Damage Reduction** — two bypass selects and an and/or operator, so `DR 10/cold iron and
    silver` and `DR 15/cold iron or good` are both expressible.
  - **Energy Resistance** and **Hardness**, each with an amount.
  - **Damage Immunity** and **Damage Vulnerability**, no amount. The type list carries PF1's damage
    *modifiers* — precision, nonlethal, area of effect — beside the ordinary types, so a swarm's
    precision immunity or an undead's nonlethal immunity is granted directly.
  - **Condition Immunity** — a *list* per entry, picked through PF1's own condition selector (the
    same checkbox list, search filter and custom-entry box the actor sheet opens), reached from a
    pencil beside the entry's tags. Every entry on the actor is unioned into `system.traits.ci`.
  - **Critical Immunity** — see below.
- **Critical Immunity has no native home in PF1 v11**, so it is published through the API rather
  than written to a field. The precision half of the trait *is* native and goes onto Damage
  Immunity; the critical half is read live off the actor by `api.isCritImmune()` /
  `api.critImmunitySources()`. [pf1-critical-effects](https://github.com/Hamilcarbarcas/pf1-critical-effects)
  reads it and marks the **Critical Effect** button on attack cards — a warning, not a lock.
- **Formulas in amount fields.** Anything the actor's roll data knows: `@cl`,
  `@abilities.con.mod`, `10 + @cl`. Resolved with `RollPF.safeRollSync`. The inputs carry the
  `formula` class, so little-helper's `= #` preview appears on them without any work on this side.
- **Named entries and self-labelling tabs.** Name an entry to title its tab; leave it blank and the
  tab describes itself (`DR 5/magic`, `ER 10 fire`, `Immune: fire`) and keeps up as you edit.
- **Per-entry Enable toggle.** Untick to park an entry without deleting it — skipped at
  recalculation, rendered dimmed and italic.
- **Stacking is per entry.** Non-stacking entries of a kind take the highest; stacking entries add
  on top of that.
- **Automatic recalculation** on item create, update, delete and toggle, debounced so a burst of
  updates costs one rebuild.
- **A collapsible section that starts in the right state** — open on items that already have
  defenses, collapsed on the rest, with the entry count badged on the shield. Which tab is open and
  whether the section is expanded last as long as the sheet stays open and are never written to the
  item.
- **Scriptable API** at `game.defenseManager` (also `game.modules.get("pf1-defense-manager").api`):
  `add`, `remove`, `list`, `clear`, `recalc`, `isCritImmune`, `critImmunitySources`,
  `defenseSources`. API entries live on actor flags, separate from the item-authored ones. The
  read-only calls accept an actor, a token, or a token document.
- **`defenseSources()`** names the items behind each DR, ER, hardness, immunity and vulnerability
  the actor has, worked out live without writing anything. astora-mod's Health Log uses it to
  name the item behind each reduction in a hit's breakdown.
- **"Use Highest Applicable DR Only"** (world setting, default on). PF1's damage application will
  otherwise let several DR entries stack against one instance; with this on, only the highest
  applicable DR applies, and it absorbs at most its amount across the whole hit. Each entry still
  records what it absorbed, as PF1's own math does, so damage logs can name it. Patched at
  `ready`, so changing it needs a world reload — the setting says so when you change it.

### Changed
- A DR entry now shows **Amount** above **Bypassed By**, the order DR is written in (DR 10/magic).

### Fixed
- **Adding or changing an entry in a sheet section no longer jumps the sheet back to the top of
  the tab.** Sections from the shared sheet kit now restore the scroll position once they have
  drawn.
