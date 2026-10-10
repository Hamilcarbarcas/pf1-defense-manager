# PF1 Defense Manager

A Foundry VTT module for the PF1 system that provides a unified interface for managing Damage Reduction (DR), Energy Resistance (ER), Damage Immunity (DI), Damage Vulnerability (DV) and Condition Immunity (CI) on a per-item basis. The module fully owns the actor's native defense trait fields and rebuilds them automatically from all active items.

## Features

- **Per-Item Defense Configuration** — Add defense entries directly on items (buffs, feats, class features, racial traits, equipment, weapons, attacks) via the Advanced tab in the item sheet. Each entry gets its own tab, so an item granting several defenses stays readable.
- **Named Entries** — Give an entry a name to title its tab. Left blank, the tab labels itself from the entry (`DR 5/magic`, `ER 10 fire`, `Immune: fire`, `Hardness 5`) and keeps up as you edit.
- **Per-Entry Enable Toggle** — Untick **Enable** to park an entry without deleting it. Disabled entries are skipped during recalculation and their tab renders dimmed and italic.
- **Damage Reduction** — DR 5/magic, DR 10/cold iron and silver, DR 15/cold iron or good, etc. Supports two damage type selects with an and/or operator.
- **Energy Resistance** — Resist Fire 10, Resist Cold 5, etc.
- **Damage Immunity** — Full immunity to a damage type (no amount needed). The type list includes PF1's damage modifiers — precision, nonlethal, and area of effect — alongside the ordinary types, so immunity to precision damage (swarms, oozes) or to nonlethal (undead, constructs) can be granted directly.
- **Damage Vulnerability** — Vulnerability to a damage type (no amount needed).
- **Condition Immunity** — Immunity to conditions (bleed, paralyzed, poison, sleep, stunned, …). The entry holds a *list*, picked through PF1's own condition selector — the same checkbox list, search filter and custom-entry box the actor sheet opens, reached from a pencil beside the entry's tags. Every Condition Immunity entry on the actor is merged into `system.traits.ci`, so the actor sheet's Condition Immunities row fills itself in and manual entry there is no longer needed.
- **Critical Immunity** — Designates the creature immune to critical hits *and* to precision damage, the way undead, constructs, oozes, elementals, plants and swarms are in core PF1. The precision half is expressible natively and goes onto the actor's Damage Immunity trait; the critical half has no native home in PF1 v11 at all, so it is published through the API for other modules to read. [pf1-critical-effects](https://github.com/Hamilcarbarcas/pf1-critical-effects) reads it and marks the **Critical Effect** button on attack cards against that creature — a warning, not a lock: the GM can still resolve a critical against it. Takes no amount, no damage type and no stacking; it is a designation, not a quantity.
- **Defense Override** – Weakens the creature's *own* defenses against every attack: ignore a DR type, energy resistance, or hardness (optionally only up to a maximum), or reduce one by an amount. A paladin's Aura of Faith, shared to nearby enemies, is a DR Bypass for Good. See [Defense Override](#defense-override).
- **Formula Support** — Amount fields accept formulas using actor roll data (e.g. `@cl`, `@abilities.con.mod`, `10 + @cl`). Resolved via `RollPF.safeRollSync`.
- **Little-Helper Integration** — Amount inputs use the `formula` CSS class, so the [little-helper](https://github.com/dmrickey/fvtt-ckl-roll-bonuses) tooltip (`= #`) appears automatically when formulas are entered.
- **Stacking Rules** — Each entry can be marked as stacking. Non-stacking entries of the same type use the highest value; stacking entries add together on top.
- **Automatic Recalculation** — Actor defense traits are rebuilt whenever items are created, updated, deleted, or toggled. Recalc is debounced to avoid rapid successive updates.
- **Scriptable API** — A public API at `game.defenseManager` (also `game.modules.get("pf1-defense-manager").api`) allows macros and other modules to add, remove, list, and clear defense entries stored on actor flags.

## Usage

### Item Sheet UI

1. Open any supported item (buff, feat, class, race, equipment, weapon, attack).
2. Go to the **Advanced** tab.
3. Find the **Granted Defenses** section (below script calls if present). It is collapsible — click the header to expand it. The header's shield icon is the control: full strength when open, dimmed when closed, with the entry count badged on the right. A section starts open only on items that already have defenses; the rest start collapsed. The choice lasts as long as the sheet stays open and is not saved to the item.
4. Click the **+** tab to add an entry. Each defense on the item is one tab; click a tab to edit that defense.
5. Optionally give it a **Name** — this titles the tab. Leave it blank to let the tab describe itself.
6. Choose a **Type** (DR, Energy Resist, Dmg Immunity, Dmg Vulnerability, Hardness, Critical Immunity, Condition Immunity, Defense Override).
7. Enter an **Amount** (number or formula). Immunities and vulnerabilities have no amount field. On a DR entry it comes first, the way DR is written (`DR 10/magic`).
8. Configure **Bypassed By** / **Damage Type** (two selects and an and/or operator for DR; one select otherwise; none for Hardness or Critical Immunity). A **Condition Immunity** entry instead shows its conditions as tags with a pencil that opens the picker.
9. Check **Stacks** if this entry should stack with others of the same type.
10. Untick **Enable** to switch an entry off without deleting it, or click the trash icon on its tab to remove it.

Defenses are applied to the actor automatically when the item is active/equipped. Which tab is open is remembered while the sheet stays open and is never saved to the item.

A **Condition Immunity** entry opens PF1's own condition selector — the pencil beside its tag list spawns the same application the actor sheet's Condition Immunities row does, complete with the search filter and the custom-entry box, so anything not in PF1's condition list can still be typed in. One entry can carry as many conditions as you like, and every entry on the actor is unioned into the actor's Condition Immunities trait. Since the module owns that field, anything typed into it directly on the actor sheet is replaced the next time defenses recalculate — put it on an item instead.

> **Note.** PF1 v11 does not enforce condition immunity anywhere; the trait is informational, exactly as it is when filled in by hand. Nothing that worked before stops working — the entry just moves where it is authored.

A **Critical Immunity** entry has no fields of its own — the whole panel is a note describing what it does. Add one to whatever grants the immunity (an undead's racial traits, a fortification enchantment) and it takes effect while that item is active, like any other entry. It is the one category with no native PF1 field behind it: v11 models critical immunity nowhere, so the module publishes the designation through its API instead. `precision` shows up in the actor's Damage Immunity list because that half *is* native.

> **Known PF1 limitation.** The system zeroes a damage instance for an immunity only when *every* damage type on that instance matches — so precision immunity catches a damage part tagged `precision` on its own, but not one tagged `piercing` **and** `precision`. Tag sneak-attack damage as precision alone.

### Defense Override

A **Defense Override** entry weakens the creature's own defenses against **every** attack, from anyone. Pick what it does from the **Override** list:

| Override | Effect |
| --- | --- |
| **DR Bypass** | Attacks get past DR of the chosen type |
| **DR Reduction** | DR of the chosen type is lower by the **Amount** |
| **ER Bypass** | Resistance to the chosen energy type is ignored |
| **ER Reduction** | Resistance to the chosen energy type is lower by the **Amount** |
| **Hardness Bypass** | Hardness is ignored |
| **Hardness Reduction** | Hardness is lower by the **Amount** |

- **Type:** a DR type, an energy type, or **Any**. DR also offers **DR/— only**. Hardness has no type.
- **Maximum** (bypasses only): only defenses this high or lower are ignored. A Hardness Bypass with a maximum of 19 ignores hardness 19, but has no effect on hardness 20. Blank means no limit.
- **Amount** (reductions only): Fire Resistance 15 with an ER Reduction of 10 blocks only 5. A defense can't go below 0. Reductions follow the usual **Stacks** rule: the highest applies unless they stack.

A DR Bypass treats every attack as having that type. So with a DR Bypass for Good:

| Creature's DR | Becomes |
| --- | --- |
| DR 5/good | nothing |
| DR 10/magic **and** good | DR 10/magic |
| DR 10/good **or** silver | nothing (a good attack always gets through) |
| DR 10/— | unchanged |

Bypasses apply first, comparing their maximum against the defense as written; reductions then lower whatever is left. The actor sheet and the damage dialog show the result, so you can see what actually applies.

**Example: Aura of Faith.** On the paladin, make an Aura of Faith buff with a 10 ft enemy aura ([PF1 Auras](https://github.com/Hamilcarbarcas/pf1-auras)), switched off with **Share while off** ticked, and give it a Defense Override: DR Bypass, Good. Enemies within 10 ft get the buff, and every attack against them counts as good. The buff stays off on the paladin, so attacks against the paladin are unaffected.

For effects that belong to the *attacker* instead (an adamantine-like weapon property, a spell that pierces resistance), use the **Defense Bypass** roll-bonus from [PF1 Magic Equipment](https://github.com/Hamilcarbarcas/pf1-magic-equipment). It offers the same overrides, applied only to that creature's attacks.

### API

```js
const api = game.defenseManager;

// Add a defense (stored on actor flags, not items)
await api.add(actor, {
  id: "resist-energy-fire",      // unique identifier
  source: "Resist Energy",       // display name
  category: "eres",              // "dr" | "eres" | "di" | "dv" | "hardness" | "critimm" | "ci"
  amount: "10",                  // number or formula string
  types: ["fire", ""],           // type identifiers
  conditions: [],                // condition ids — category "ci" only
  operator: true,                // true = "or", false = "and" (DR only)
  stacking: false,               // whether this stacks
  enabled: true                  // false parks the entry without removing it
});

// Condition immunity — a list, not a single type
await api.add(actor, {
  id: "undead-traits",
  source: "Undead Traits",
  category: "ci",
  conditions: ["sleep", "paralyze", "poison", "stun", "disease"],
});

// Defense override: attacks against this creature ignore hardness up to 19
await api.add(actor, {
  id: "sunder-weakness",
  source: "Sunder Weakness",
  category: "override",
  mode: "hardnessBypass",          // drBypass | drReduce | erBypass | erReduce | hardnessBypass | hardnessReduce
  types: ["", ""],                 // DR or energy type; "*" any; "-" DR/— only; blank for hardness
  max: "19",                       // bypasses: highest defense ignored; blank = no limit
});

// Remove by id
await api.remove(actor, "resist-energy-fire");

// List all API entries on an actor
const entries = api.list(actor);

// Clear all API entries
await api.clear(actor);

// Force recalculation
await api.recalc(actor);
```

Critical immunity is read live off the actor rather than off a derived field, so there is nothing to
recalculate and nothing to go stale. Both calls accept an actor, a token, or a token document:

```js
api.isCritImmune(token);          // true | false
api.critImmunitySources(token);   // ["Undead Traits", …] — empty when not immune
```

Which items supply each defense, for a damage readout. Computed live the same way, and written
nowhere. A non-stacking defense names only the entry that won; a stacking one names every
contributor. API entries are named by their `source`.

```js
api.defenseSources(token);
// {
//   dr:       [{ amount: 10, types: ["good", ""], operator: true, sources: ["Ogre Hide"] }],
//   eres:     [{ amount: 10, types: ["fire", ""], operator: true, sources: ["Resist Energy"] }],
//   hardness: { amount: 0, sources: [] },
//   di:       { precision: ["Undead Traits"] },
//   dv:       { fire: ["Frost Giant"] },
// }
```

`dr` and `eres` line up with `system.traits.dr.value` / `.eres.value`; match on amount, types and
operator.

## Compatibility

- **Foundry VTT**: v13+
- **System**: PF1 (Pathfinder 1st Edition)