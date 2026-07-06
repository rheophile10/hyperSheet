// Shared test fixture: the turtles dashboard document (the 📊 Turtles doc) as a
// windowed-worksheet RECIPE for the sheet-host / formula-bar / window suites.
// DERIVED from the shipped archive (plastron-examples/origin/apps/docs/turtles.json)
// at import time, so the fixture and the desktop demo can't drift.
//
// FORMULA-FIRST + collections doctrine: turtle_data is the editable grid;
// turtle_charts holds the =rows() hub-form pivot (B1), the species filter cell
// (B2), the =FILTER derivation (B3), and ONE =view("🐢 dashboard", …) formula
// (B4) that grows the select + bar/line/pie pane. NB: =view needs an open
// WORKBOOK to attach its pane to; suites that assert the pane (turtles-pattern)
// open one first — data-only consumers (origin.test's xlsx round-trip) don't.
import { readFileSync } from "node:fs";

const doc = JSON.parse(readFileSync(new URL("../../plastron-examples/origin/apps/docs/turtles.json", import.meta.url), "utf8"));

// one at("a1", …) entry per cel; formula sources single-quoted (they use only
// double quotes inside), scalar values passed through as quoted literals.
const atEntry = (cel) => {
  const addr = cel.metadata.name.toLowerCase();
  if (cel.celType === "FormulaCel") {
    if (cel.f.includes("'")) throw new Error(`fixture: ${cel.key} formula has single quotes — update the quoting here`);
    return `at("${addr}", '${cel.f}')`;
  }
  const v = cel.v;
  return typeof v === "number" ? `at("${addr}", "${v}")` : `at("${addr}", ${JSON.stringify(String(v))})`;
};
const segCels = (name) => doc.segments.find((s) => s.name === name).cels;
const dims = (cels) => {
  let rows = 1, cols = 1;
  for (const c of cels) {
    const m = /^([A-Z]+)(\d+)$/.exec(c.metadata.name);
    if (!m) continue;
    cols = Math.max(cols, m[1].charCodeAt(0) - 64);
    rows = Math.max(rows, Number(m[2]));
  }
  return { rows, cols };
};
const chartCels = segCels("turtle_charts");
const dataCels = segCels("turtle_data");
const cd = dims(chartCels), dd = dims(dataCels);

const TURTLES = `=segment(
	cels("turtle_charts", ${cd.rows}, ${cd.cols},
		geom(0, 0.4, 0.8, 0.6),
		${chartCels.map(atEntry).join(",\n\t\t")}),
	cels("turtle_data", ${dd.rows}, ${dd.cols},
		geom(0, 0, 0.8, 0.4),
		${dataCels.map(atEntry).join(",\n\t\t")}))
`;

export async function openTurtlesFixture(state, resolveFn) {
  await resolveFn(state, "origin.run")(state, "turtledemo.run", TURTLES);
  await resolveFn(state, "view.refresh")(state);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "dom.paint");
  return state;
}
