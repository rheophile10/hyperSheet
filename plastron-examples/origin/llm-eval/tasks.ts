// tasks — the matrix axes. A BASE task describes WHAT to build (no output-format
// instruction); a MODE wraps it with HOW to return it. The matrix runner crosses
// base × mode × model, so each app is exercised as a bare formula, a #raw= link,
// and a compressed #f= link — the three ways an LLM is asked to hand plastron back.

export interface BaseTask { id: string; build: string }
export interface Mode { id: string; label: string; instruction: string }

export const BASE_TASKS: BaseTask[] = [
  { id: "keyboard",          build: "Build a piano-style musical keyboard that LOOKS like a keyboard: a row of white note keys (C D E F G A B) sized and bordered like piano keys, each a clickable button that plays its tone via origin.tone. When a key is pressed it should visibly change colour." },
  { id: "solar-system",      build: "Build a simple solar-system model: the sun and a few planets as circles, drawn on a canvas (or as dom)." },
  { id: "spreadsheet-chart", build: "Build a small spreadsheet of data (a few labeled rows with numbers) and draw a bar chart of those numbers in a cell of the same sheet." },
  { id: "invoice-let",       build: "Build an invoice: seed a price and a quantity, then show subtotal, 13% tax, and grand total as a labeled, readable sheet. Use LET so the subtotal is named and not recomputed." },
  { id: "sum-of-squares",    build: "Build a sheet with the numbers 1..6 in a column and, in another cell of the SAME sheet, the sum of their squares computed with MAP and LAMBDA." },
  { id: "running-total",     build: "Build a sheet with a column of daily amounts and, in an adjacent column, the running total shown per row (each cell its own value, not one array), using SCAN with a LAMBDA." },
  { id: "rowwise-totals",    build: "Build a small grid of numbers (a few rows, a few columns) and compute each row's total in a new column, one value per row, using BYROW with a LAMBDA." },
  { id: "navbar",            build: "Build a navigation menu for a plastron desktop: top-level Files; a Charts menu with two nested options (a pie chart and a bar chart, each spawning a small data sheet + chart when clicked); and an entry that focuses the origin (元) window. It must work on BOTH mobile and desktop." },
  { id: "kanban",            build: "Build a kanban board as a draggable window over a task sheet. Seed a sheet of a few tasks, each with a title and a status that is one of 'To Do', 'Doing', or 'Done'. Show three columns — To Do, Doing, Done — and render each task as a card in the column matching its status. The cards must be DRAGGABLE between columns, and dropping a card on a column must update that task's status so the card stays in the new column. Deliver it as ONE shareable formula." },
  { id: "play-c",            build: "Build a single clickable button that plays middle C (origin.tone 261.63)." },
];

export const MODES: Mode[] = [
  {
    id: "formula",
    label: "bare formula",
    instruction: "Output ONLY the plastron formula — no prose, no markdown code fences, nothing else.",
  },
  {
    id: "raw",
    label: "#raw= link",
    instruction:
      "Give me a #raw= shareable plastron.ca link that opens it: take a valid =formula and URL-encode it after `https://plastron.ca/#raw=`. Output ONLY the link, nothing else.",
  },
  {
    id: "f",
    label: "#f= base64 link",
    instruction:
      "Give me a COMPRESSED #f= (base64url) shareable plastron.ca link that opens it (tag char + base64url of the formula; raw-DEFLATE for tag '1', plain for tag '0' — emit the shorter). " +
      "Output ONLY the link. If you cannot produce the base64url payload yourself, output ONLY the exact =formula instead.",
  },
];

/** Compose the full prompt sent to a model for one (base, mode) cell. */
export const composePrompt = (base: BaseTask, mode: Mode): string =>
  `${base.build}\n\nUse the plastron verbs in the guide. ${mode.instruction}`;
