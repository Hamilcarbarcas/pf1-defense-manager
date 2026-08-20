/* ============================================================
 * PF1 Defense Manager
 *
 * Manages energy resistances, damage reductions, damage
 * immunities, and damage vulnerabilities via item flags.
 * Fully owns the actor's native trait fields and rebuilds
 * them from all active items whenever defenses change.
 * ============================================================ */

const MODULE_ID = "pf1-defense-manager";
const TEMPLATE_PATH = `modules/${MODULE_ID}/src/templates/defense-entries.hbs`;

/* ---- Flag Data Structure ----
 *
 * Item flag: flags.pf1-defense-manager.defenses = [
 *   { name: "",  enabled: true, category: "dr",   amount: "5",   types: ["magic", ""], operator: true,  stacking: false },
 *   { name: "",  enabled: true, category: "eres", amount: "@cl", types: ["fire", ""],  operator: true,  stacking: false },
 *   { name: "",  enabled: true, category: "di",   amount: "0",   types: ["fire", ""],  operator: true,  stacking: false },
 *   { name: "",  enabled: true, category: "dv",   amount: "0",   types: ["cold", ""],  operator: true,  stacking: false },
 *   { name: "",  enabled: true, category: "critimm", amount: "0", types: ["", ""],     operator: true,  stacking: false },
 *   { name: "",  enabled: true, category: "ci",   conditions: ["bleed", "sleep"] },
 * ]
 *
 * `name` is an optional label for the entry's tab; blank falls back to a summary
 * derived from the entry itself. `enabled` is opt-out — entries written before it
 * existed have no such key and count as enabled (see isEntryEnabled).
 *
 * Amount supports formulas using actor roll data variables (e.g. @cl, @abilities.con.mod, etc.)
 *
 * Actor flag: flags.pf1-defense-manager.apiDefenses = [
 *   { id: "unique-id", source: "Resist Energy", category: "eres", amount: "10", types: ["fire",""], operator: true, stacking: false },
 * ]
 */

/* ============================================================
 * Helpers
 * ============================================================ */

function getItemDefenses(item) {
  const raw = item.getFlag(MODULE_ID, "defenses");
  if (!raw) return [];
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return []; }
  }
  // Legacy: migrate old array/object format
  return Array.isArray(raw) ? [...raw] : Object.values(raw);
}

function getApiDefenses(actor) {
  const raw = actor.getFlag(MODULE_ID, "apiDefenses");
  if (!raw) return [];
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return Array.isArray(raw) ? [...raw] : Object.values(raw);
}

/**
 * Replace the defenses flag wholesale — stores as JSON string to avoid Foundry's deep-merge.
 *
 * `render: false` persists without re-drawing the sheet, which the tabbed UI uses
 * for edits it can reflect itself (everything but a category switch, which swaps
 * out the panel's controls). Item hooks still fire, so recalc is unaffected.
 *
 * @param {Item} item
 * @param {object[]} defenses
 * @param {object} [options]
 * @param {boolean} [options.render=true]
 */
async function setItemDefenses(item, defenses, { render = true } = {}) {
  await item.update({ [`flags.${MODULE_ID}.defenses`]: JSON.stringify(defenses) }, { render });
}

/** Entries predating the `enabled` field have no such key and are live. */
function isEntryEnabled(entry) {
  return entry?.enabled !== false;
}

/* Critical immunity.
 *
 * PF1 v11 models this nowhere — no trait, no field, no fortification handling — so unlike every
 * other category there is no native actor field to rebuild. It therefore has two halves:
 *
 *  1. The half PF1 *can* express: immunity to precision damage, folded into `system.traits.di`
 *     during recalc. Every creature immune to criticals in core PF1 (undead, constructs, oozes,
 *     elementals, plants, swarms) is precision-immune by the same clause, so it is one entry.
 *  2. The half nothing native can hold: the designation itself, which consumers read live off the
 *     actor through the API rather than off a derived field. Nothing is persisted for it — the
 *     entries ARE the state, so it cannot go stale and it works on synthetic token actors.
 */
const CRIT_IMMUNITY = "critimm";

/** The damage modifier a Critical Immunity entry contributes to `system.traits.di`. */
const CRIT_IMMUNITY_DI_TYPE = "precision";

const isCritImmunityEntry = (entry) => entry?.category === CRIT_IMMUNITY && isEntryEnabled(entry);

/* Condition immunity.
 *
 * The one category whose entry holds a *list* rather than a single type, because that is the shape
 * of the native trait behind it: `system.traits.ci` is a flat array mixing standard condition ids
 * with free-text custom entries. Entries therefore carry `conditions: []` instead of `types`, and
 * recalc unions every entry's list into that array — the same "we own the field" contract the other
 * categories have with dr / eres / di / dv.
 */
const CONDITION_IMMUNITY = "ci";

/** An entry's condition list, tolerating entries written before the field existed. */
function entryConditions(entry) {
  const list = entry?.conditions;
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

/** Check if an item is "active" (should contribute defenses). */
function isItemActive(item) {
  // Buffs: must be active
  if (item.type === "buff") return item.system.active === true;
  // Features/class/race/equipment: check if not disabled
  if (item.system.disabled !== undefined) return !item.system.disabled;
  // Equipment: check equipped
  if (item.system.equipped !== undefined) return item.system.equipped;
  return true;
}

/** Generate a unique key for a defense entry (for stacking comparison). */
function defenseKey(entry) {
  if (entry.category === "di" || entry.category === "dv") {
    return `${entry.category}|${entry.types[0]}`;
  }
  // DR/ER: key by category + sorted types + operator
  const t = [...entry.types].sort();
  return `${entry.category}|${t.join(",")}|${entry.operator}`;
}

/* ============================================================
 * Recalculation Engine
 * ============================================================ */

/** Resolve a formula string to a number using actor roll data. */
function resolveAmount(formula, rollData) {
  if (typeof formula === "number") return formula;
  const str = String(formula ?? "0").trim();
  if (!str) return 0;
  try {
    return pf1.dice.RollPF.safeRollSync(str, rollData).total;
  } catch {
    return Number(str) || 0;
  }
}

async function recalcDefenses(actor) {
  if (!actor || actor.type === "vehicle") return;

  const rollData = actor.getRollData();

  // Collect all defense entries from active items
  const allEntries = [];

  for (const item of actor.items) {
    if (!isItemActive(item)) continue;
    const defs = getItemDefenses(item);
    for (const d of defs) {
      if (!isEntryEnabled(d)) continue;
      allEntries.push({ ...d, _resolved: resolveAmount(d.amount, rollData), _source: item.name });
    }
  }

  // Add API defenses from actor flags
  for (const d of getApiDefenses(actor)) {
    if (!isEntryEnabled(d)) continue;
    allEntries.push({ ...d, _resolved: resolveAmount(d.amount, rollData) });
  }

  // Separate by category
  const dr = allEntries.filter(e => e.category === "dr");
  const eres = allEntries.filter(e => e.category === "eres");
  const di = allEntries.filter(e => e.category === "di");
  const dv = allEntries.filter(e => e.category === "dv");
  const hardness = allEntries.filter(e => e.category === "hardness");
  const ci = allEntries.filter(e => e.category === CONDITION_IMMUNITY);
  const critImmune = allEntries.some(e => e.category === CRIT_IMMUNITY);

  // Apply stacking rules to DR and ER
  const drResult = applyStackingRules(dr);
  const eresResult = applyStackingRules(eres);

  // DI/DV: just unique type sets. Critical immunity rides in as precision immunity — the Set
  // makes it idempotent, so an actor carrying both it and an explicit `di: precision` gets one.
  const diResult = [...new Set([
    ...di.map(e => e.types[0]),
    ...(critImmune ? [CRIT_IMMUNITY_DI_TYPE] : []),
  ].filter(Boolean))];
  const dvResult = [...new Set(dv.map(e => e.types[0]).filter(Boolean))];

  // Condition immunity: the union of every entry's list. Standard ids and custom strings share the
  // array, exactly as the native trait stores them.
  const ciResult = [...new Set(ci.flatMap(entryConditions))];

  // Hardness: apply stacking rules then sum to a single value
  const hardnessStacked = applyStackingRules(hardness);
  const hardnessResult = hardnessStacked.reduce((sum, e) => sum + (e.amount ?? 0), 0);

  // Build update
  const update = {
    "system.traits.dr": {
      value: drResult.map(e => ({ amount: e.amount, types: e.types, operator: e.operator })),
      custom: "",
    },
    "system.traits.eres": {
      value: eresResult.map(e => ({ amount: e.amount, types: e.types, operator: e.operator })),
      custom: "",
    },
    "system.traits.di": diResult,
    "system.traits.dv": dvResult,
    "system.traits.hardness": hardnessResult,
  };

  // Only character and npc carry a condition immunity trait; nothing else has one to own.
  if (actor.system.traits?.ci !== undefined) update["system.traits.ci"] = ciResult;

  await actor.update(update, { [MODULE_ID]: { noRecalc: true } });
}

/**
 * Apply stacking rules:
 * - Group by defenseKey
 * - For each group: highest non-stacking + sum of all stacking
 * - Return merged list
 */
function applyStackingRules(entries) {
  const groups = new Map();

  for (const entry of entries) {
    const key = defenseKey(entry);
    if (!groups.has(key)) groups.set(key, { stacking: [], nonStacking: [] });
    const group = groups.get(key);
    if (entry.stacking) {
      group.stacking.push(entry);
    } else {
      group.nonStacking.push(entry);
    }
  }

  const result = [];
  for (const [, group] of groups) {
    const maxNonStacking = group.nonStacking.reduce((max, e) => (e._resolved ?? e.amount) > (max._resolved ?? max.amount) ? e : max, { _resolved: 0, amount: 0 });
    const stackingTotal = group.stacking.reduce((sum, e) => sum + (e._resolved ?? e.amount), 0);
    const total = (maxNonStacking._resolved ?? maxNonStacking.amount ?? 0) + stackingTotal;

    // Use the template from the highest non-stacking entry, or first stacking entry
    const template = group.nonStacking[0] || group.stacking[0];
    if (!template) continue;

    result.push({
      amount: total,
      types: [...template.types],
      operator: template.operator,
    });
  }

  return result;
}

/* ============================================================
 * Item Sheet Injection
 * ============================================================ */

function buildTypeOptions() {
  const damageTypes = [];
  const energyTypes = [];
  const drTypes = [];

  // DR bypass types from registry: physical damage types, damageResistances config, and materials
  const reg = pf1.registry.damageTypes;
  if (reg) {
    for (const dt of pf1.utils.naturalSort([...reg], "name")) {
      const id = dt.id ?? dt._id;
      const label = dt.name ?? id;
      const cat = dt.category?.toLowerCase?.() ?? "";

      // Modifiers (precision, nonlethal, areaOfEffect) carry no category, so they
      // fall out of the energy/physical lists below on their own. They belong in
      // damageTypes though: immunity to precision damage or nonlethal is real, and
      // core PF1 offers them in its own DI/DV selector.
      damageTypes.push({ id, label });

      if (cat === "energy") {
        energyTypes.push({ id, label });
      }

      // DR gets physical category types (bludgeoning, piercing, slashing, plus any custom physical)
      if (cat === "physical") {
        drTypes.push({ id, label });
      }
    }
  }

  // DR alignment/special types from config
  const drIds = new Set(drTypes.map(t => t.id));
  for (const [id, label] of Object.entries(pf1.config.damageResistances ?? {})) {
    if (!drIds.has(id)) {
      drTypes.push({ id, label: game.i18n.localize(label) });
      drIds.add(id);
    }
  }

  // DR materials from registry
  const matReg = pf1.registry.materials;
  if (matReg) {
    for (const mat of pf1.utils.naturalSort([...matReg], "name")) {
      const matId = mat.id ?? mat._id;
      if (mat.dr && !mat.treatedAs && !drIds.has(matId)) {
        drTypes.push({ id: matId, label: mat.shortName || mat.name });
        drIds.add(matId);
      }
    }
  }

  // Add epic/magic as special DR types if not already present
  if (!drIds.has("epic")) drTypes.push({ id: "epic", label: game.i18n.localize("DM.DrType.Epic") });
  if (!drIds.has("magic")) drTypes.push({ id: "magic", label: game.i18n.localize("DM.DrType.Magic") });

  drTypes.sort((a, b) => a.label.localeCompare(b.label));
  damageTypes.sort((a, b) => a.label.localeCompare(b.label));
  energyTypes.sort((a, b) => a.label.localeCompare(b.label));

  return { damageTypes, energyTypes, drTypes, conditionChoices: buildConditionChoices() };
}

/**
 * The condition choices the selector offers, id → label, sorted by label the way the actor
 * sheet's own condition immunity selector presents them.
 *
 * `pf1.config.conditionTypes` is localized in place at startup; localize() is a no-op on an
 * already-translated string and covers the case where it is not.
 *
 * @returns {Record<string, string>}
 */
function buildConditionChoices() {
  const collator = new Intl.Collator(game.i18n.lang, { numeric: true, ignorePunctuation: true });
  return Object.fromEntries(
    Object.entries(pf1.config.conditionTypes ?? {})
      .map(([id, label]) => [id, game.i18n.localize(label)])
      .sort(([, a], [, b]) => collator.compare(a, b))
  );
}

/** Human label for a stored type id, searched across every option list. */
function typeLabel(id, options) {
  if (!id) return "";
  for (const list of [options.drTypes, options.energyTypes, options.damageTypes]) {
    const hit = list.find((t) => t.id === id);
    if (hit) return hit.label;
  }
  return id;
}

/**
 * Tab label for an entry: the user's own name if they gave one, otherwise a
 * summary read off the entry ("DR 5/magic", "Immune: fire", …). Recomputed
 * live as fields change, so it stays in step without a re-render.
 *
 * @param {object} entry
 * @param {number} index Position in the list, for the unconfigured fallback.
 * @param {object} options Output of buildTypeOptions().
 * @returns {string}
 */
function entryLabel(entry, index, options) {
  const named = String(entry?.name ?? "").trim();
  if (named) return named;

  const amount = String(entry?.amount ?? "").trim();
  const t0 = typeLabel(entry?.types?.[0], options);
  const t1 = typeLabel(entry?.types?.[1], options);
  const fallback = game.i18n.format("DM.Tab.Unset", { n: index + 1 });

  switch (entry?.category) {
    case "dr": {
      const op = game.i18n.localize(entry.operator ? "DM.Operator.Or" : "DM.Operator.And");
      const bypass = [t0, t1].filter(Boolean).join(` ${op} `) || "—";
      return `${game.i18n.localize("DM.Tab.Dr")} ${amount || 0}/${bypass}`;
    }
    case "eres":
      return `${game.i18n.localize("DM.Tab.Eres")} ${amount || 0}${t0 ? ` ${t0}` : ""}`;
    case "di":
      return t0 ? `${game.i18n.localize("DM.Tab.Di")}: ${t0}` : fallback;
    case "dv":
      return t0 ? `${game.i18n.localize("DM.Tab.Dv")}: ${t0}` : fallback;
    case "hardness":
      return `${game.i18n.localize("DM.Tab.Hardness")} ${amount || 0}`;
    case CRIT_IMMUNITY:
      return game.i18n.localize("DM.Tab.CritImm");
    case CONDITION_IMMUNITY: {
      const head = game.i18n.localize("DM.Tab.Ci");
      const picked = entryConditions(entry).map((c) => options.conditionChoices?.[c] ?? c);
      // The tab strip ellipsizes, so the whole list can go in — a long one still reads
      // left-to-right until it runs out of room.
      return picked.length ? `${head}: ${picked.join(", ")}` : head;
    }
    default:
      return fallback;
  }
}

/**
 * Which controls a category's panel needs.
 *
 * Precomputed rather than tested in the template: the conditions had already reached a doubled
 * `{{#unless}}` for the amount field, and critical immunity — which asks for nothing at all —
 * would have made every one of them a three-way.
 *
 * @param {string} category
 */
function panelFields(category) {
  const bare = category === CRIT_IMMUNITY || category === CONDITION_IMMUNITY;
  return {
    showTypes: category !== "hardness" && !bare,
    showAmount: category !== "di" && category !== "dv" && !bare,
    // Nothing to stack: the entry is a designation or a list, not a quantity.
    showStacking: !bare,
    isCritImmunity: category === CRIT_IMMUNITY,
    isConditionImmunity: category === CONDITION_IMMUNITY,
  };
}

/* ============================================================
 * Condition Selector
 * ============================================================ */

/**
 * PF1's own condition picker, retargeted at a defense entry.
 *
 * `ActorTraitSelector` is a DocumentSheetV2 that reads a document path on open and writes that same
 * path on submit. Ours lives inside a JSON blob one level down, so both ends are diverted: the
 * checked boxes are seeded from `initial`, and submit hands the result to `onSave` instead of
 * touching the document. Everything else — the checkbox list, the search filter, the custom-tag
 * input, the styling — is the system's, which is the point.
 *
 * Built lazily because `pf1` does not exist when this file is evaluated.
 *
 * @type {typeof import("@app/trait-selector.mjs").ActorTraitSelector | null}
 */
let ConditionSelector = null;

function getConditionSelector() {
  if (ConditionSelector) return ConditionSelector;

  ConditionSelector = class DefenseConditionSelector extends pf1.applications.ActorTraitSelector {
    static DEFAULT_OPTIONS = {
      form: { handler: DefenseConditionSelector._saveConditions },
    };

    constructor(options) {
      super(options);

      // The base class filled these from `this.attribute`, which for us points at nothing.
      for (const key of options.initial ?? []) {
        if (this.options.choices[key]) this.attributes.standard.add(key);
        else this.attributes.custom.add(key);
      }
    }

    /**
     * @this {DefenseConditionSelector}
     */
    static async _saveConditions() {
      // Detach first, as the base class does: our own save re-renders the item.
      delete this.document.apps[this.appId];
      const { standard, custom } = this.attributes;
      await this.options.onSave([...standard.union(custom)]);
      this.close({ force: true });
    }
  };

  return ConditionSelector;
}

/** A freshly added entry — DR 5/magic is the most common thing anyone wants. */
function newEntry() {
  return { name: "", enabled: true, category: "dr", amount: "5", types: ["magic", ""], operator: true, stacking: false };
}

Hooks.on("renderItemSheet", (app, html, data) => {
  const item = app.document;
  if (!item) return;

  // Only inject on types that make sense
  const validTypes = ["buff", "feat", "class", "race", "equipment", "weapon", "attack"];
  if (!validTypes.includes(item.type)) return;

  const defenses = getItemDefenses(item);
  const typeOptions = buildTypeOptions();

  const templateData = {
    defenses: defenses.map((d, i) => ({
      ...d,
      enabled: isEntryEnabled(d),
      label: entryLabel(d, i, typeOptions),
      conditionTags: entryConditions(d).map((c) => ({
        id: c,
        label: typeOptions.conditionChoices[c] ?? c,
      })),
      ...panelFields(d.category),
    })),
    ...typeOptions,
  };

  // Template is preloaded at init, so this returns synchronously from cache
  const rendered = Handlebars.partials[TEMPLATE_PATH]
    ? Handlebars.partials[TEMPLATE_PATH](templateData)
    : "";
  if (!rendered) return;

  // Inject below script calls, or at end of advanced tab
  const advancedTab = html.find(".tab.advanced > .flexcol");
  if (!advancedTab.length) return;

  const scriptCalls = advancedTab.find(".script-calls");
  if (scriptCalls.length) {
    scriptCalls.after(rendered);
  } else {
    advancedTab.append(rendered);
  }

  // Wire up event listeners
  const section = html.find(".defense-manager-section");

  /* ---- Tab strip ------------------------------------------------------- */

  // Which tab is open, remembered across the sheet's re-renders. Transient UI
  // state on the app instance — never written to the item. Entries are keyed by
  // array position, so the index is re-clamped whenever the list shrinks.
  let active = app._dmActive ?? 0;
  if (!(active >= 0 && active < defenses.length)) active = defenses.length ? 0 : -1;
  app._dmActive = active;

  const applyActive = () => {
    section.find(".dm-tab, .dm-panel").removeClass("active");
    if (active >= 0) {
      section.find(`.dm-tab[data-index="${active}"]`).addClass("active");
      section.find(`.dm-panel[data-index="${active}"]`).addClass("active");
    }
  };
  applyActive();

  section.find(".dm-tab").not(".dm-tab-add").on("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    active = Number(ev.currentTarget.dataset.index);
    app._dmActive = active;
    applyActive();
  });

  // "+" tab — add a defense and open it.
  section.find(".dm-tab-add").on("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const current = getItemDefenses(item);
    current.push(newEntry());
    app._dmActive = current.length - 1;
    await setItemDefenses(item, current);
  });

  /** Re-derive one tab's label and dimming from the stored entry. */
  const refreshTab = (index) => {
    const entry = getItemDefenses(item)[index];
    const $tab = section.find(`.dm-tab[data-index="${index}"]`);
    $tab.find(".dm-tab-label").text(entryLabel(entry, index, typeOptions));
    $tab.toggleClass("dm-tab-disabled", !isEntryEnabled(entry));
  };

  /* ---- Panel fields ---------------------------------------------------- */

  // Fields carry data-dm rather than name= so the host sheet's own form
  // submission never picks them up; we persist every edit ourselves.
  section.find(".dm-panel").on("change", "[data-dm]", async (ev) => {
    ev.stopPropagation();
    const el = ev.currentTarget;
    const index = Number(el.dataset.index);
    const current = getItemDefenses(item);
    const entry = current[index];
    if (!entry) return;

    // A category switch changes which controls the panel needs, so it is the one
    // edit that re-renders; everything else is reflected in place.
    let needsRender = false;

    switch (el.dataset.dm) {
      case "type":
        entry.category = el.value;
        needsRender = true;
        // Reset to sensible defaults when switching category
        if (el.value === "di" || el.value === "dv") {
          entry.amount = "0";
          entry.types = ["fire", ""];
        } else if (el.value === CONDITION_IMMUNITY) {
          entry.amount = "0";
          entry.types = ["", ""];
          entry.conditions ??= [];
        } else if (el.value === "hardness" || el.value === CRIT_IMMUNITY) {
          entry.amount = "0";
          entry.types = ["", ""];
        } else if (el.value === "eres") {
          entry.types = ["fire", ""];
          entry.operator = true;
        } else {
          entry.types = ["magic", ""];
          entry.operator = true;
        }
        break;
      case "name":
        entry.name = String(el.value).trim();
        break;
      case "enabled":
        entry.enabled = el.checked;
        break;
      case "types0":
        entry.types[0] = el.value;
        break;
      case "types1":
        entry.types[1] = el.value;
        break;
      case "operator":
        entry.operator = el.value === "true";
        break;
      case "amount":
        entry.amount = el.value;
        break;
      case "stacking":
        entry.stacking = el.checked;
        break;
      default:
        return;
    }

    await setItemDefenses(item, current, { render: needsRender });
    if (!needsRender) refreshTab(index);
  });

  // Typing in the name or amount box retitles its tab as you go; the value
  // itself is persisted on change, above.
  section.find(".dm-panel").on("input", '[data-dm="name"], [data-dm="amount"]', (ev) => {
    const index = Number(ev.currentTarget.dataset.index);
    const entry = { ...getItemDefenses(item)[index] };
    if (ev.currentTarget.dataset.dm === "name") entry.name = String(ev.currentTarget.value).trim();
    else entry.amount = ev.currentTarget.value;
    section.find(`.dm-tab[data-index="${index}"] .dm-tab-label`).text(entryLabel(entry, index, typeOptions));
  });

  // Open the condition picker for this entry.
  section.find(".dm-ci-edit").on("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const index = Number(ev.currentTarget.dataset.index);

    // One picker per entry, so two condition immunity entries on the same item do not fight over
    // the same window. The index is captured, not re-derived — an entry deleted while the picker
    // is open would shift it, but the save re-reads the list and bails if the slot is gone.
    const id = `dm-ci-${item.uuid.replaceAll(".", "-")}-${index}`;
    const open = foundry.applications.instances.get(id);
    if (open) return void open.bringToFront();

    new (getConditionSelector())({
      id,
      document: item,
      // No such path: the base class reads it on open and finds nothing, which is what we want —
      // `initial` seeds the checkboxes instead.
      name: `flags.${MODULE_ID}.__conditions`,
      subject: "conditionTypes",
      title: game.i18n.localize("DM.Field.Conditions"),
      hasCustom: true,
      choices: typeOptions.conditionChoices,
      initial: entryConditions(getItemDefenses(item)[index]),
      onSave: async (conditions) => {
        const current = getItemDefenses(item);
        if (!current[index]) return;
        current[index].conditions = conditions;
        await setItemDefenses(item, current);
      },
    }).render({ force: true });
  });

  // Delete this defense.
  section.find(".dm-entry-delete").on("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const index = Number(ev.currentTarget.dataset.index);
    const current = getItemDefenses(item);
    if (!current[index]) return;

    const label = entryLabel(current[index], index, typeOptions);
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DM.Dialog.Delete.Title") },
      content: game.i18n.format("DM.Dialog.Delete.Content", {
        name: foundry.utils.escapeHTML(label),
      }),
      rejectClose: false,
      modal: true,
    });
    if (!ok) return;

    current.splice(index, 1);
    // Keep the neighbour open rather than jumping back to the first tab.
    app._dmActive = Math.min(index, current.length - 1);
    await setItemDefenses(item, current);
  });

  wireCollapse(app, section[0], defenses.length);
});

/* ============================================================
 * Hooks — Collapsible section
 * ============================================================ */

/**
 * The section is a tall block on every item that can hold defenses, and most
 * hold none. Collapse it to its header, using the header's own shield icon as
 * the disclosure control — full strength open, dimmed closed — with the entry
 * count badged on the right so a configured item still reads at a glance.
 *
 * Expanded state is remembered only while the sheet stays open, keyed by
 * `appId`; reopening re-applies the default of "open only if it has entries".
 *
 * @type {Map<number, boolean>}
 */
const expandedByApp = new Map();

/**
 * @param {ItemSheet} app
 * @param {HTMLElement} section
 * @param {number} count Configured defense entries.
 */
function wireCollapse(app, section, count) {
  const header = section?.querySelector(".dm-header");
  const body = section?.querySelector(".dm-body");
  if (!header || !body) return;

  header.classList.add("dm-collapse-header");
  header.setAttribute("title", game.i18n.localize("DM.Section.Toggle"));

  if (count > 0) {
    const badge = document.createElement("span");
    badge.className = "dm-collapse-badge";
    badge.textContent = String(count);
    header.append(badge);
  }

  let expanded = expandedByApp.get(app.appId) ?? count > 0;
  const apply = () => {
    section.classList.toggle("dm-collapsed", !expanded);
    body.style.display = expanded ? "" : "none";
  };
  apply();

  header.addEventListener("click", (ev) => {
    if (ev.target.closest("a, button, input, select")) return;
    ev.preventDefault();
    expanded = !expanded;
    expandedByApp.set(app.appId, expanded);
    apply();
  });
}

Hooks.on("closeItemSheet", (app) => expandedByApp.delete(app.appId));

/* ============================================================
 * Hooks — Auto Recalc
 * ============================================================ */

// Debounce recalc per actor to avoid rapid successive updates
const recalcTimers = new Map();

function scheduleRecalc(actor) {
  if (!actor) return;
  const id = actor.id;
  if (recalcTimers.has(id)) clearTimeout(recalcTimers.get(id));
  recalcTimers.set(id, setTimeout(() => {
    recalcTimers.delete(id);
    recalcDefenses(actor);
  }, 100));
}

// Item created on actor
Hooks.on("createItem", (item, options, userId) => {
  if (game.user.id !== userId) return;
  if (!item.actor) return;
  if (getItemDefenses(item).length === 0) return;
  scheduleRecalc(item.actor);
});

// Item updated (flag changes, active toggle, equipped toggle)
Hooks.on("updateItem", (item, changes, options, userId) => {
  if (game.user.id !== userId) return;
  if (!item.actor) return;

  // Check if defense flags changed, or active/disabled/equipped changed
  const flagChanged = changes.flags?.[MODULE_ID];
  const activeChanged = changes.system?.active !== undefined
    || changes.system?.disabled !== undefined
    || changes.system?.equipped !== undefined;

  if (flagChanged || (activeChanged && getItemDefenses(item).length > 0)) {
    scheduleRecalc(item.actor);
  }
});

// Item deleted from actor
Hooks.on("deleteItem", (item, options, userId) => {
  if (game.user.id !== userId) return;
  if (!item.actor) return;
  if (getItemDefenses(item).length === 0) return;
  scheduleRecalc(item.actor);
});

// Actor updated (stats changed that may affect formulas)
Hooks.on("updateActor", (actor, changes, options, userId) => {
  if (game.user.id !== userId) return;
  // Skip if this update was triggered by us (avoid loop)
  if (options?.[MODULE_ID]?.noRecalc) return;
  // Only recalc if system data changed (abilities, level, etc.)
  if (!changes.system) return;
  // Check if any items on this actor have defense entries
  const hasDefenses = actor.items.some(i => getItemDefenses(i).length > 0) || getApiDefenses(actor).length > 0;
  if (!hasDefenses) return;
  scheduleRecalc(actor);
});

/* ============================================================
 * Public API
 * ============================================================ */

class DefenseManagerAPI {
  /**
   * Add a defense entry via API (stored on actor flags).
   * @param {Actor} actor
   * @param {object} options
   * @param {string} options.id - Unique identifier for this entry
   * @param {string} options.source - Display name of the source
   * @param {string} options.category - "dr" | "eres" | "di" | "dv" | "hardness" | "critimm" | "ci"
   * @param {string|number} [options.amount="0"] - Amount or formula (e.g. "5", "@cl", "10 + @abilities.con.mod")
   * @param {string[]} [options.types=["",""]] - Type identifiers
   * @param {string[]} [options.conditions=[]] - Condition ids, for category "ci" (see pf1.config.conditionTypes).
   *   Unrecognised strings are kept as custom entries, as on the native trait.
   * @param {boolean} [options.operator=true] - true=or, false=and (for DR)
   * @param {boolean} [options.stacking=false] - Whether this stacks
   * @param {boolean} [options.enabled=true] - Set false to park the entry without removing it
   */
  async add(actor, { id, source, category, amount = 0, types = ["", ""], conditions = [], operator = true, stacking = false, enabled = true } = {}) {
    if (!actor || !id || !category) throw new Error("actor, id, and category are required");
    const current = getApiDefenses(actor);
    const existing = current.findIndex(e => e.id === id);
    const entry = { id, source, category, amount, types: [...types], conditions: [...conditions], operator, stacking, enabled };
    if (existing >= 0) {
      current[existing] = entry;
    } else {
      current.push(entry);
    }
    await actor.setFlag(MODULE_ID, "apiDefenses", current);
    await recalcDefenses(actor);
  }

  /**
   * Remove an API defense entry by id.
   * @param {Actor} actor
   * @param {string} id
   */
  async remove(actor, id) {
    if (!actor || !id) return;
    const current = getApiDefenses(actor).filter(e => e.id !== id);
    await actor.setFlag(MODULE_ID, "apiDefenses", current);
    await recalcDefenses(actor);
  }

  /**
   * List all API defense entries on an actor.
   * @param {Actor} actor
   * @returns {object[]}
   */
  list(actor) {
    return getApiDefenses(actor);
  }

  /**
   * Clear all API defense entries.
   * @param {Actor} actor
   */
  async clear(actor) {
    await actor.unsetFlag(MODULE_ID, "apiDefenses");
    await recalcDefenses(actor);
  }

  /**
   * Force recalculation of an actor's defenses.
   * @param {Actor} actor
   */
  async recalc(actor) {
    await recalcDefenses(actor);
  }

  /**
   * Whether this actor is immune to critical hits.
   *
   * Computed live from the actor's active items and API entries rather than read off a derived
   * field — see the CRIT_IMMUNITY note above for why there is no field to read. Cheap enough to
   * call per attack; the loop is over one actor's items.
   *
   * @param {Actor|TokenDocument|Token} actor - An actor, or anything carrying one.
   * @returns {boolean}
   */
  isCritImmune(actor) {
    return this.critImmunitySources(actor).length > 0;
  }

  /**
   * The names of everything granting this actor critical immunity, for a tooltip or a readout.
   *
   * @param {Actor|TokenDocument|Token} actor - An actor, or anything carrying one.
   * @returns {string[]} Empty when the actor is not crit-immune.
   */
  critImmunitySources(actor) {
    const doc = actor?.documentName === "Actor" ? actor : actor?.actor ?? null;
    if (!doc) return [];

    const sources = [];
    for (const item of doc.items ?? []) {
      if (!isItemActive(item)) continue;
      if (getItemDefenses(item).some(isCritImmunityEntry)) sources.push(item.name);
    }
    for (const entry of getApiDefenses(doc)) {
      if (isCritImmunityEntry(entry)) sources.push(entry.source || entry.id);
    }
    return sources;
  }
}

/**
 * PF1 system applies each active DR entry sequentially, which effectively stacks DR.
 * Patch it so only the highest applicable DR applies per damage instance.
 */
function patchPF1ApplyDamageDR() {
  const ApplyDamage = pf1?.applications?.ApplyDamage;
  if (!ApplyDamage?.prototype) return;
  if (ApplyDamage.prototype._pf1DefenseManagerDrPatched) return;

  const original = ApplyDamage.prototype._processReductions;

  ApplyDamage.prototype._processReductions = function (target, instances, reductions, dr) {
    // Keep vanilla behavior for ER
    if (!dr) return original.call(this, target, instances, reductions, dr);

    let total = 0;
    const active = reductions.filter((r) => r?.active && (r.value ?? 0) > 0);

    for (const instance of instances) {
      if (instance.total <= 0) continue;

      let best = null;
      for (const r of active) {
        if (!this._isReducedBy(target, instance, r, true)) continue;
        if (!best || (r.value ?? 0) > (best.value ?? 0)) best = r;
      }

      if (!best) continue;

      // Use a temporary availability bucket so DR isn't accumulated from multiple entries
      const temp = { available: best.value };
      total += this._applyReduction(target, instance, temp, true);
    }

    return total;
  };

  ApplyDamage.prototype._pf1DefenseManagerDrPatched = true;
  console.log(`${MODULE_ID} | Patched PF1 DR processing (highest applicable DR only)`);
}

/* ============================================================
 * Init
 * ============================================================ */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

  game.settings.register(MODULE_ID, "useHighestDrOnly", {
    name: "DM.Settings.HighestDrOnly.Name",
    hint: "DM.Settings.HighestDrOnly.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      ui.notifications.info(game.i18n.localize("DM.Settings.HighestDrOnly.ReloadNotice"));
    },
  });

  // Register Handlebars helpers
  Handlebars.registerHelper("eq", (a, b) => a === b);

  // Preload template so renderTemplate is synchronous later
  loadTemplates([TEMPLATE_PATH]);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);

  // Patch PF1 damage application DR behavior to prevent unintended stacking
  if (game.settings.get(MODULE_ID, "useHighestDrOnly")) {
    patchPF1ApplyDamageDR();
  }

  // Expose API
  const api = new DefenseManagerAPI();
  game.modules.get(MODULE_ID).api = api;
  game.defenseManager = api;
});
