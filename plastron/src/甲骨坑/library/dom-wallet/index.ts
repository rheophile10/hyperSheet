import type { 甲骨, Cel, Fn, EventBinding } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import { dom, style, attr, on } from "../dom/utils/vocab.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// dom-wallet — the wallet panel, authored as dom() FORMULAS.
//
// A showcase that interactive UI can be a formula. Where unsafe-wallet's
// walletFn builds the same panel with hand-rolled el()/t() vnodes, domWallet
// expresses it through the dom()/style()/attr()/on() VOCABULARY — the public
// presentation verbs any segment depending on `dom` can call. The output is an
// ordinary vnode tree the painter consumes, and the buttons/inputs wire to the
// SAME unsafe-wallet dispatch handlers (wallet.unlock / .lock / .setNamed /
// .del) — no new handlers, no new module state. This segment owns zero secrets
// and zero IO; it is a pure render over unsafe-wallet's surface.
//
// A native verb fn receives only its formula args (no state, no record), so —
// unlike walletFn, which reads unsafe-wallet's module-scope Map from inside the
// same module — domWallet cannot reach the wallet's live lock state directly.
// Instead it COMPOSES the wallet's existing reader verbs, taking their results
// as args:
//
//   =domWallet(locked(walletNote), apiKeys())
//
// `locked(walletNote)` is the boolean lock state (true = locked), already
// reactive on walletNote; `apiKeys()` is the wallet's own newline-joined key
// names (or a "(wallet …)" hint string). Passing them as args makes the panel
// react through inputMap — locked/apiKeys ARE the dependencies — with zero
// changes to unsafe-wallet. domWallet stays a pure presentation fn.
// ============================================================================

// The vocab's on() emits a {dispatch} binding; the name field needs a
// {set,extract} listener (write the typed name to the wallet.newName buffer
// cel, no dispatch). dom() reads any child shaped { __on: { event, binding } }
// and folds binding into the element's events bag — so we author the set
// listener as that same vocab CHILD shape with a set-binding. This stays inside
// the dom() vocabulary (dom consumes it) without modifying the dom segment.
const setOn = (event: string, binding: EventBinding): { __on: { event: string; binding: EventBinding } } =>
  ({ __on: { event, binding } });

// Styles mirror unsafe-wallet's walletFn so the formula-authored panel looks
// identical to the hand-built one.
const PANEL = "display:flex;align-items:center;gap:.5rem;flex-wrap:wrap";
const COL = "display:flex;flex-direction:column;gap:.35rem";
const STAT = "font-family:ui-monospace,monospace;font-size:.82rem;color:CanvasText";
const NAME = "font-family:ui-monospace,monospace;font-size:.85rem;padding:.15rem .4rem;border:1px solid #8884;border-radius:.3rem;background:#8881;min-width:8rem";
const PW = "font-family:ui-monospace,monospace;font-size:.85rem;padding:.15rem .4rem;border:1px solid #8884;border-radius:.3rem;background:#8881;min-width:14rem";
const CAP = "font-size:.75rem;color:GrayText;font-family:system-ui;margin-left:.4rem";
const BTN = "font-family:ui-monospace,monospace;font-size:.8rem;padding:.15rem .55rem;border:1px solid #8884;border-radius:.3rem;background:#8881;cursor:pointer";
const CHIP = "display:inline-flex;align-items:center;gap:.3rem;font-family:ui-monospace,monospace;font-size:.82rem;padding:.1rem .2rem .1rem .45rem;border:1px solid #8884;border-radius:.4rem;background:#8881";
const DEL = "font-family:ui-monospace,monospace;font-size:.75rem;padding:.1rem .4rem;border:1px solid #d4453e55;border-radius:.3rem;background:#d4453e1a;color:#d4453e;cursor:pointer";
const EDIT = "font-family:ui-monospace,monospace;font-size:.75rem;padding:.1rem .4rem;border:1px solid #8884;border-radius:.3rem;background:#8881;color:CanvasText;cursor:pointer";

type StyleChild = ReturnType<typeof style>;
// expand a "prop:value;prop:value" string into style(prop, value, …).
const styleOf = (css: string): StyleChild => {
  const pairs: string[] = [];
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    pairs.push(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
  }
  return style(...pairs);
};

type Vnode = ReturnType<typeof dom>;

// A password box wired to a dispatch handler on BOTH change (blur) and keydown
// (Enter) — mirrors unsafe-wallet's pwInput. The handlers gate on shouldSubmit,
// so non-Enter keystrokes are ignored. payload, when given, rides each binding.
const pwBox = (dispatch: string, payload: unknown, placeholder: string, caption: string): Vnode => {
  const change = payload === undefined ? on("change", dispatch) : on("change", dispatch, payload);
  const keydown = payload === undefined ? on("keydown", dispatch) : on("keydown", dispatch, payload);
  return dom("span",
    dom("input",
      attr("type", "password", "placeholder", placeholder),
      styleOf(PW),
      change, keydown,
    ),
    dom("span", styleOf(CAP), caption),
  );
};

// domWallet(lock, names?) — the wallet panel as a dom() formula.
//   lock   : the boolean lock state, e.g. from locked(walletNote) (truthy =
//            locked). A bare =domWallet() with no args reads as locked.
//   names  : the wallet's key names, e.g. from apiKeys() — either a
//            newline-joined list or a "(wallet …)" hint string (treated as no
//            keys). Only consulted when unlocked.
//
// Locked → status + an unlock password box (wallet.unlock). Unlocked → status +
// a lock button (wallet.lock) + a chip-with-✕ per stored key (wallet.del) + an
// add-a-key row (name → wallet.newName buffer via a set listener; secret →
// wallet.setNamed). Pass locked(walletNote)/apiKeys() so the cel re-fires on
// lock/unlock/set (reactivity through inputMap — those verbs ARE the deps).
const domWalletFn: Fn = (lock?: unknown, names?: unknown): Vnode => {
  const locked = lock === undefined ? true : Boolean(lock);

  if (locked) {
    return dom("div", styleOf(PANEL),
      dom("span", styleOf(STAT), "🔒 locked"),
      pwBox("wallet.unlock", undefined, "wallet password…",
        "Enter = unlock (first password creates the wallet)"),
    );
  }

  // apiKeys() returns "(wallet empty …)" / "(wallet locked …)" or a
  // newline-joined name list. A leading "(" marks a hint, not real names.
  const raw = String(names ?? "");
  const keyNames = raw.startsWith("(") ? [] : raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const n = keyNames.length;

  const chips = keyNames.map((name) =>
    dom("span", styleOf(CHIP),
      `🔑 ${name}`,
      dom("button",
        attr("type", "button", "title", `edit "${name}"`),
        styleOf(EDIT),
        on("click", "wallet.startEdit", name),
        "✎",
      ),
      dom("button",
        attr("type", "button", "title", `delete "${name}"`),
        styleOf(DEL),
        on("click", "wallet.del", name),
        "✕",
      ),
    ));

  const addRow = dom("div", styleOf(PANEL),
    dom("input",
      attr("type", "text", "placeholder", "new key name"),
      styleOf(NAME),
      setOn("input", { set: "wallet.newName", extract: "value" }),
    ),
    dom("input",
      attr("type", "password", "placeholder", "secret… (Enter to add)"),
      styleOf(PW),
      on("change", "wallet.setNamed"),
      on("keydown", "wallet.setNamed"),
    ),
  );

  return dom("div", styleOf(COL),
    dom("div", styleOf(PANEL),
      dom("span", styleOf(STAT), `🔓 unlocked — ${n} key${n === 1 ? "" : "s"}`),
      dom("button", attr("type", "button"), styleOf(BTN), on("click", "wallet.lock"), "🔒 lock"),
    ),
    ...(chips.length ? [dom("div", styleOf(PANEL), ...chips)] : []),
    addRow,
  );
};

export const name = "dom-wallet" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["domWallet", domWalletFn],
]));
