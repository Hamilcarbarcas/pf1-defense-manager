/* ============================================================
 * Temporary Hit Points. DESIGN.md §3
 *
 * Named pools of temporary hit points on an actor flag, always
 * summing to `system.attributes.hp.temp`. Buffs grant pools
 * through `temphp` entries; every other change to the field is
 * reconciled into the pools as it is written.
 * ============================================================ */

import { MODULE_ID, getItemDefenses, isEntryEnabled } from "./shared.mjs";

/** Entry category and condition id. */
export const TEMP_HP = "temphp";

const LEDGER = "tempHp";
const LOCKS = "tempHpLocks";
const TEMP_PATH = "system.attributes.hp.temp";

/** Update option marking the engine's own writes. */
// A fresh object per call: Foundry writes parent, pack, and updates into the options it is given.
const ownWrite = () => ({ [MODULE_ID]: { tempHp: true } });
const isOwnWrite = (options) => !!options?.[MODULE_ID]?.tempHp;

/** Lock units, in seconds. A round is read from core config when called. */
export const LOCK_UNITS = {
  round: () => CONFIG.time.roundTime || 6,
  minute: () => 60,
  hour: () => 3600,
};

const LASTS = ["active", "spent"];
const LOCK_FROM = ["end", "grant"];

/* ============================================================
 * Ledger
 * ============================================================ */

/*
 * Pool: { key, source, itemId, lasts, value, original, addedAt }
 *
 * The Unsourced pool has key "" and original null; it merges every untracked addition.
 * Lock: { until, source } once running, { itemId, seconds, source } while waiting on its buff to end.
 */

/** Character and NPC actors; nothing else carries temp HP. */
const hasTempHp = (actor) => {
  const hp = actor?.system?.attributes?.hp;
  return !!hp && typeof hp === "object" && "temp" in hp;
};

const currentTemp = (actor) => Math.max(0, Number(actor.system.attributes.hp.temp) || 0);

const now = () => game.time.worldTime;

function readLedger(actor) {
  const raw = actor.getFlag(MODULE_ID, LEDGER);
  return Array.isArray(raw) ? foundry.utils.deepClone(raw) : [];
}

function readLocks(actor) {
  const raw = actor.getFlag(MODULE_ID, LOCKS);
  return raw && typeof raw === "object" ? foundry.utils.deepClone(raw) : {};
}

const total = (pools) => pools.reduce((sum, p) => sum + p.value, 0);

/** The buff a pool belongs to, if it is still on the actor. */
const poolItem = (actor, pool) => (pool.itemId ? actor.items.get(pool.itemId) ?? null : null);

/** World time a buff's tracker effect runs out; Infinity with no duration. */
function expiryOf(item) {
  const d = item?.effect?.duration;
  if (!d?.seconds) return Infinity;
  return (Number(d.startTime) || 0) + d.seconds;
}

/**
 * Spend order: loose pools (Unsourced first, then oldest), then buff pools soonest to expire,
 * ties oldest first.
 */
function spendOrder(actor, pools) {
  const rank = (p) => {
    const item = poolItem(actor, p);
    if (!item) return { tier: 0, sub: p.key === "" ? -Infinity : 0, addedAt: p.addedAt ?? 0 };
    return { tier: 1, sub: expiryOf(item), addedAt: p.addedAt ?? 0 };
  };
  return [...pools]
    .map((p) => ({ p, r: rank(p) }))
    .sort((a, b) => a.r.tier - b.r.tier || a.r.sub - b.r.sub || a.r.addedAt - b.r.addedAt)
    .map(({ p }) => p);
}

/** Lower the pools by `amount` in spend order. Mutates; drops emptied pools. */
function spend(actor, pools, amount) {
  let left = amount;
  for (const pool of spendOrder(actor, pools)) {
    if (left <= 0) break;
    const take = Math.min(pool.value, left);
    pool.value -= take;
    left -= take;
  }
  return pools.filter((p) => p.value > 0);
}

/** Add to the Unsourced pool, creating it if needed. Mutates. */
function addUnsourced(pools, amount) {
  const pool = pools.find((p) => p.key === "");
  if (pool) pool.value += amount;
  else pools.push({ key: "", source: "", itemId: null, lasts: "spent", value: amount, original: null, addedAt: now() });
  return pools;
}

/** The ledger made to sum to `temp`: a shortfall goes to Unsourced, an excess is spent. */
function healed(actor, temp = currentTemp(actor)) {
  let pools = readLedger(actor).filter((p) => p.value > 0);
  const sum = total(pools);
  if (sum < temp) pools = addUnsourced(pools, temp - sum);
  else if (sum > temp) pools = spend(actor, pools, sum - temp);
  return pools;
}

/** Locks still in force. Waiting locks whose buff is gone are dropped. */
function liveLocks(actor) {
  const out = {};
  const t = now();
  for (const [key, lock] of Object.entries(readLocks(actor))) {
    if (lock?.itemId) {
      if (actor.items.has(lock.itemId)) out[key] = lock;
    } else if (Number(lock?.until) > t) {
      out[key] = lock;
    }
  }
  return out;
}

/** Seconds left on a lock; Infinity while it waits for its buff to end. */
function lockLeft(lock) {
  if (!lock) return 0;
  if (lock.itemId) return Infinity;
  return Math.max(0, lock.until - now());
}

/** Write pools and locks, and set the field to their sum. */
async function commit(actor, pools, locks) {
  const update = {
    [TEMP_PATH]: total(pools),
    [`flags.${MODULE_ID}.${LEDGER}`]: pools,
  };
  if (locks) update[`flags.${MODULE_ID}.==${LOCKS}`] = locks;
  return actor.update(update, ownWrite());
}

/* One operation at a time per actor: two buffs turning on together would otherwise both read
 * the ledger before either write landed. */
const queues = new Map();

function enqueue(actor, op) {
  const id = actor.uuid;
  const run = (queues.get(id) ?? Promise.resolve())
    .then(op)
    .catch((err) => console.error(`${MODULE_ID} | temp HP update for ${actor.name} failed`, err));
  queues.set(id, run);
  run.finally(() => { if (queues.get(id) === run) queues.delete(id); });
  return run;
}

/* ============================================================
 * Operations
 * ============================================================ */

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "∞";
  const s = Math.ceil(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

async function rollAmount(formula, rollData) {
  if (typeof formula === "number") return Math.max(0, Math.floor(formula));
  const str = String(formula ?? "").trim();
  if (!str) return 0;
  const roll = await pf1.dice.RollPF.safeRoll(str, rollData);
  if (roll.err) {
    console.error(`${MODULE_ID} | temp HP formula "${str}" failed`, roll.err);
    return 0;
  }
  return Math.max(0, Math.floor(roll.total));
}

/**
 * Grant a pool. Same key: the higher of what is left and the new amount wins (§3.4).
 *
 * @param {Actor} actor
 * @param {object} grant
 * @param {number} grant.amount
 * @param {string} grant.key Blank adds to Unsourced.
 * @param {string} [grant.source]
 * @param {string|null} [grant.itemId]
 * @param {"active"|"spent"} [grant.lasts]
 * @param {{seconds:number, from:"end"|"grant"}|null} [grant.lock]
 * @returns {Promise<number>} The temp HP actually added.
 */
async function grant(actor, { amount, key, source = "", itemId = null, lasts = "active", lock = null }) {
  let pools = healed(actor);
  const locks = liveLocks(actor);
  const label = source || key;

  if (key && locks[key]) {
    const left = lockLeft(locks[key]);
    // A rage started inside the window still restarts the clock when it ends.
    if (lock?.from === "end" && itemId) locks[key] = { itemId, seconds: lock.seconds, source: label };
    ui.notifications.info(game.i18n.format("DM.TempHp.Withheld", { source: label, time: formatTime(left) }));
    await commit(actor, pools, locks);
    return 0;
  }

  if (key && lock?.seconds > 0) {
    locks[key] = lock.from === "end" && itemId
      ? { itemId, seconds: lock.seconds, source: label }
      : { until: now() + lock.seconds, source: label };
  }

  let added = 0;
  if (amount > 0) {
    if (!key) {
      pools = addUnsourced(pools, amount);
      added = amount;
    } else {
      const existing = pools.find((p) => p.key === key);
      if (!existing || amount > existing.value) {
        added = amount - (existing?.value ?? 0);
        pools = pools.filter((p) => p !== existing);
        pools.push({ key, source, itemId, lasts: itemId ? lasts : "spent", value: amount, original: amount, addedAt: now() });
      }
    }
  }

  await commit(actor, pools, locks);
  return added;
}

/** A buff turned off or left: drop or loosen its pools, start its waiting locks. */
async function release(actor, itemId) {
  const ledger = readLedger(actor);
  const locks = readLocks(actor);
  if (!ledger.some((p) => p.itemId === itemId) && !Object.values(locks).some((l) => l?.itemId === itemId)) return;

  let pools = healed(actor);
  pools = pools
    .filter((p) => !(p.itemId === itemId && p.lasts !== "spent"))
    .map((p) => (p.itemId === itemId ? { ...p, itemId: null } : p));

  const t = now();
  for (const [key, lock] of Object.entries(locks)) {
    if (lock?.itemId === itemId) locks[key] = { until: t + lock.seconds, source: lock.source };
  }
  await commit(actor, pools, locks);
}

/* ============================================================
 * Buff entries
 * ============================================================ */

/** Defaults for an entry switched to Temporary HP. */
export function newTempHpFields() {
  return { key: "", lasts: "active", lock: { value: 0, unit: "minute", from: "end" } };
}

/** The entry's key; blank falls back to the buff's tag. */
export function tempHpEntryKey(item, entry) {
  const own = String(entry?.key ?? "").trim();
  if (own) return own;
  return item?.system?.tag || pf1.utils.createTag(item?.name ?? "") || item?.id || "";
}

/** "Temp HP 2d6 + @cl". */
export function tempHpEntryLabel(entry) {
  const amount = String(entry?.amount ?? "").trim() || 0;
  return `${game.i18n.localize("DM.Tab.TempHp")} ${amount}`;
}

function entryLock(entry) {
  const value = Number(entry?.lock?.value) || 0;
  const unit = LOCK_UNITS[entry?.lock?.unit] ?? LOCK_UNITS.minute;
  if (value <= 0) return null;
  return { seconds: value * unit(), from: LOCK_FROM.includes(entry.lock.from) ? entry.lock.from : "end" };
}

const tempHpEntries = (item) => getItemDefenses(item).filter((e) => e.category === TEMP_HP && isEntryEnabled(e));

/** Roll and grant every Temporary HP entry on a buff that just turned on. */
function grantFromBuff(item) {
  const actor = item.actor;
  const entries = tempHpEntries(item);
  if (!actor || !entries.length || !hasTempHp(actor)) return;

  enqueue(actor, async () => {
    const rollData = item.getRollData();
    for (const entry of entries) {
      const amount = await rollAmount(entry.amount, rollData);
      await grant(actor, {
        amount,
        key: tempHpEntryKey(item, entry),
        source: String(entry.name ?? "").trim() || item.name,
        itemId: item.id,
        lasts: LASTS.includes(entry.lasts) ? entry.lasts : "active",
        lock: entryLock(entry),
      });
    }
  });
}

Hooks.on("createItem", (item, _options, userId) => {
  if (game.user.id !== userId || item.type !== "buff" || !item.actor) return;
  if (item.isActive) grantFromBuff(item);
});

Hooks.on("updateItem", (item, changes, _options, userId) => {
  if (game.user.id !== userId || item.type !== "buff" || !item.actor) return;
  const active = changes.system?.active;
  if (active === true) grantFromBuff(item);
  else if (active === false) enqueue(item.actor, () => release(item.actor, item.id));
});

Hooks.on("deleteItem", (item, _options, userId) => {
  if (game.user.id !== userId || item.type !== "buff" || !item.actor) return;
  enqueue(item.actor, () => release(item.actor, item.id));
});

/* ============================================================
 * Reconciling outside writes (§3.3)
 * ============================================================ */

Hooks.on("preUpdateActor", (actor, changes, options) => {
  if (isOwnWrite(options) || !hasTempHp(actor)) return;
  const next = foundry.utils.getProperty(changes, TEMP_PATH);
  if (next === undefined) return;

  const target = Math.max(0, Number(next) || 0);
  if (target !== next) foundry.utils.setProperty(changes, TEMP_PATH, target);

  const before = currentTemp(actor);
  let pools = healed(actor, before);
  if (target > before) pools = addUnsourced(pools, target - before);
  else if (target < before) pools = spend(actor, pools, before - target);
  // Sheet submits carry the field unchanged; leave the flag alone then.
  if (JSON.stringify(pools) === JSON.stringify(readLedger(actor))) return;
  foundry.utils.setProperty(changes, `flags.${MODULE_ID}.${LEDGER}`, pools);
});

/* ============================================================
 * The temphp condition (§3.7)
 * ============================================================ */

Hooks.on("pf1RegisterConditions", (registry) => {
  if (registry.has(TEMP_HP)) return;
  try {
    registry.register(MODULE_ID, TEMP_HP, {
      name: "DM.Condition.TempHp",
      texture: "icons/svg/regen.svg",
      showInAction: false,
      showInDefense: false,
    });
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to register the temporary HP condition`, err);
  }
});

const markerOf = (actor) => actor.effects.find((ae) => ae.statuses?.has(TEMP_HP)) ?? null;

/** On while temp HP is above 0, off at 0. */
Hooks.on("updateActor", (actor, changes, _options, userId) => {
  if (game.user.id !== userId || !hasTempHp(actor)) return;
  if (foundry.utils.getProperty(changes, TEMP_PATH) === undefined) return;
  const want = currentTemp(actor) > 0;
  if (want === !!markerOf(actor)) return;
  actor.setCondition(TEMP_HP, want, ownWrite());
});

const isActorMarker = (ae) => ae.parent?.documentName === "Actor" && ae.statuses?.has(TEMP_HP);

// Clicked on by hand with nothing there: ask how much.
Hooks.on("createActiveEffect", (ae, options, userId) => {
  if (game.user.id !== userId || isOwnWrite(options) || !isActorMarker(ae)) return;
  const actor = ae.parent;
  if (!hasTempHp(actor) || currentTemp(actor) > 0) return;
  promptTempHp(actor);
});

// Clicked off by hand: every pool goes.
Hooks.on("deleteActiveEffect", (ae, options, userId) => {
  if (game.user.id !== userId || isOwnWrite(options) || !isActorMarker(ae)) return;
  const actor = ae.parent;
  if (!hasTempHp(actor) || currentTemp(actor) <= 0) return;
  enqueue(actor, () => commit(actor, []));
});

async function promptTempHp(actor) {
  const esc = foundry.utils.escapeHTML;
  const content = `
    <div class="form-group">
      <label>${esc(game.i18n.localize("DM.TempHp.Prompt.Amount"))}</label>
      <div class="form-fields"><input type="text" name="formula" value="" autofocus /></div>
    </div>
    <div class="form-group">
      <label>${esc(game.i18n.localize("DM.TempHp.Prompt.Source"))}</label>
      <div class="form-fields"><input type="text" name="source" value="" placeholder="${esc(game.i18n.localize("DM.TempHp.Prompt.SourcePlaceholder"))}" /></div>
    </div>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.format("DM.TempHp.Prompt.Title", { name: actor.name }), icon: "fa-solid fa-heart" },
    position: { width: 360 },
    content,
    buttons: [{
      action: "apply",
      label: game.i18n.localize("DM.TempHp.Prompt.Apply"),
      icon: "fa-solid fa-check",
      default: true,
      callback: (_event, button) => {
        const form = new FormData(button.form);
        return { formula: String(form.get("formula") ?? "").trim(), source: String(form.get("source") ?? "").trim() };
      },
    }],
    rejectClose: false,
  });

  const amount = result?.formula ? await rollAmount(result.formula, actor.getRollData()) : 0;
  if (amount <= 0) {
    if (currentTemp(actor) <= 0 && markerOf(actor)) await actor.setCondition(TEMP_HP, false, ownWrite());
    return;
  }
  const key = result.source ? pf1.utils.createTag(result.source) || result.source : "";
  enqueue(actor, () => grant(actor, { amount, key, source: result.source }));
}

/* ============================================================
 * Display
 * ============================================================ */

/** One line per pool in spend order, then running locks. */
function describe(actor) {
  const pools = spendOrder(actor, healed(actor)).map((p) => {
    const name = p.source || game.i18n.localize("DM.TempHp.Unsourced");
    const value = p.original ? `${p.value}/${p.original}` : `${p.value}`;
    return { name, value };
  });
  const locks = Object.entries(liveLocks(actor))
    .filter(([, l]) => !l.itemId)
    .map(([key, l]) => ({ name: l.source || key, time: formatTime(lockLeft(l)) }));
  return { pools, locks };
}

function tooltipBody({ pools, locks }) {
  const esc = foundry.utils.escapeHTML;
  const lines = pools.map((p) => `<li>${esc(p.name)} ${p.value}</li>`);
  for (const l of locks) {
    lines.push(`<li class="dm-temphp-lock">${esc(game.i18n.format("DM.TempHp.Locked", { source: l.name, time: l.time }))}</li>`);
  }
  return `<strong>${game.i18n.localize("DM.TempHp.Heading")}</strong><ul>${lines.join("")}</ul>`;
}

const tooltipHTML = (desc) => `<div class="dm-temphp-tooltip">${tooltipBody(desc)}</div>`;

const rootOf = (html) => (html instanceof HTMLElement ? html : html?.[0] ?? null);

function appendSection(container, desc) {
  if (container.querySelector(".dm-temphp-tooltip")) return;
  const section = document.createElement("div");
  section.classList.add("dm-temphp-tooltip");
  section.innerHTML = tooltipBody(desc);
  container.append(section);
}

const hasAnything = (desc) => desc.pools.length || desc.locks.length;

// Sheet Buffs tab. Little Helper's condition tooltip, when present, absorbs ours.
Hooks.on("renderActorSheet", (app, html) => {
  const root = rootOf(html);
  const actor = app.actor ?? app.document;
  if (!root || !actor || !hasTempHp(actor)) return;
  const el = root.querySelector(`.buffs-conditions a.checkbox[data-condition-id="${TEMP_HP}"]`);
  if (!el) return;
  const desc = describe(actor);
  if (!hasAnything(desc)) return;

  el.dataset.tooltip = tooltipHTML(desc);
  const conditionDiv = el.closest(".condition");
  requestAnimationFrame(() => {
    const lil = conditionDiv?.querySelector(":scope > .lil-tooltip");
    if (!lil) return;
    delete el.dataset.tooltip;
    conditionDiv.addEventListener("pointerenter", () => {
      requestAnimationFrame(() => appendSection(lil, describe(actor)));
    });
  });
});

Hooks.on("renderTokenHUD", (hud, html) => {
  const root = rootOf(html);
  const actor = hud.object?.actor;
  if (!root || !actor || !hasTempHp(actor)) return;
  const desc = describe(actor);
  if (!hasAnything(desc)) return;
  for (const el of root.querySelectorAll(`.status-effects [data-status-id="${TEMP_HP}"]`)) {
    el.dataset.tooltip = tooltipHTML(desc);
  }
});

Hooks.on("little-helper.hud.tooltip.active", (tooltip, { actor, condition } = {}) => {
  if (condition?.id !== TEMP_HP || !actor || !hasTempHp(actor)) return;
  const desc = describe(actor);
  if (hasAnything(desc)) appendSection(tooltip, desc);
});

// The HP extended tooltip lists the pools too.
Hooks.on("renderPF1ExtendedTooltip", (sheet, identifier, template) => {
  if (identifier !== "hit-points") return;
  const actor = sheet.actor;
  if (!actor || !hasTempHp(actor)) return;
  const { pools } = describe(actor);
  if (!pools.length) return;
  const head = document.createElement("h4");
  head.textContent = game.i18n.localize("DM.TempHp.Heading");
  template.content.append(head);
  for (const p of pools) {
    const flavor = document.createElement("span");
    flavor.classList.add("flavor");
    flavor.textContent = p.name;
    const value = document.createElement("span");
    value.classList.add("value", "untyped");
    value.textContent = p.value;
    template.content.append(flavor, value);
  }
});

/* ============================================================
 * API (§3.8): game.defenseManager.tempHp
 * ============================================================ */

const toActor = (doc) => (doc?.documentName === "Actor" ? doc : doc?.actor ?? null);

function requireActor(doc) {
  const actor = toActor(doc);
  if (!actor || !hasTempHp(actor)) throw new Error(`${MODULE_ID} | temp HP needs an actor with hit points`);
  return actor;
}

const keyFor = (key, source) => String(key ?? "").trim() || (source ? pf1.utils.createTag(source) || source : "");

export const tempHpApi = {
  /**
   * Grant temp HP. Same key: the higher of what is left and the new amount wins.
   *
   * @param {Actor|Token|TokenDocument} actor
   * @param {object} options
   * @param {number|string} options.amount A number or formula (rolled against `item`, else the actor).
   * @param {string} [options.source] Display name.
   * @param {string} [options.key] Defaults to the source as a tag; blank with no source adds to Unsourced.
   * @param {Item|string} [options.item] A buff the pool belongs to: spent in its expiry order and
   *   removed when it turns off (unless `lasts: "spent"`).
   * @param {"active"|"spent"} [options.lasts="active"]
   * @param {{seconds:number, from?:"end"|"grant"}} [options.lock] Withholds re-grants of this key.
   *   "end" needs `item` and starts when it turns off; otherwise it starts now.
   * @returns {Promise<number>} Temp HP actually added; 0 when locked or lower than what is left.
   */
  async add(actor, { amount, source = "", key, item, lasts = "active", lock } = {}) {
    actor = requireActor(actor);
    const doc = typeof item === "string" ? actor.items.get(item) : item;
    const k = keyFor(key, source);
    return enqueue(actor, async () => grant(actor, {
      amount: await rollAmount(amount, doc?.getRollData?.() ?? actor.getRollData()),
      key: k,
      source,
      itemId: doc?.id ?? null,
      lasts: LASTS.includes(lasts) ? lasts : "active",
      lock: lock?.seconds > 0 ? { seconds: Number(lock.seconds), from: lock.from === "end" && doc ? "end" : "grant" } : null,
    }));
  },

  /**
   * Raise or lower one pool and the actor's temp HP together. A positive delta creates the pool.
   *
   * @param {Actor|Token|TokenDocument} actor
   * @param {string} key
   * @param {number} delta
   */
  async adjust(actor, key, delta) {
    actor = requireActor(actor);
    delta = Math.trunc(Number(delta) || 0);
    if (!delta) return;
    return enqueue(actor, async () => {
      let pools = healed(actor);
      const pool = pools.find((p) => p.key === (key ?? ""));
      if (!pool) {
        if (delta < 0) return;
        if (!key) pools = addUnsourced(pools, delta);
        else pools.push({ key, source: key, itemId: null, lasts: "spent", value: delta, original: delta, addedAt: now() });
      } else {
        pool.value = Math.max(0, pool.value + delta);
        if (pool.original !== null) pool.original = Math.max(pool.original + Math.max(0, delta), pool.value);
        pools = pools.filter((p) => p.value > 0);
      }
      await commit(actor, pools);
    });
  },

  /** Remove one pool and what is left of it. */
  async remove(actor, key) {
    actor = requireActor(actor);
    return enqueue(actor, () => commit(actor, healed(actor).filter((p) => p.key !== (key ?? ""))));
  },

  /** Remove every pool. Locks stay. */
  async clear(actor) {
    actor = requireActor(actor);
    return enqueue(actor, () => commit(actor, []));
  },

  /** The pools, in spend order. */
  list(actor) {
    actor = toActor(actor);
    if (!actor || !hasTempHp(actor)) return [];
    return spendOrder(actor, healed(actor)).map((p) => ({ ...p }));
  },

  /** Seconds left on a key's lock: 0 when free, Infinity while it waits for its buff to end. */
  lockRemaining(actor, key) {
    actor = toActor(actor);
    if (!actor) return 0;
    return lockLeft(liveLocks(actor)[key]);
  },
};
