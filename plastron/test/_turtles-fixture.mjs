// Shared test fixture: materialize the turtles + turtlecharts worksheets — the
// same content the 📊 Turtles launcher opens — as a windowed-worksheet fixture
// for the sheet-host / formula-bar / window suites.
//
// In the browser the launcher reads /turtles.f from OPFS (seedStarter writes it
// from the bundle's starter/). Unit tests have no OPFS manifest to seed, so we
// read the SAME starter file from the repo and run it directly — no duplication,
// always in sync with what ships.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const TURTLES = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plastron-examples", "origin", "starter", "turtles.f"),
  "utf8",
);

export async function openTurtlesFixture(state, resolveFn) {
  // commit into a holding cell OUTSIDE the turtles/turtlecharts namespaces, so a
  // turtles window's formula bar stays empty until a turtles cell is selected.
  await resolveFn(state, "origin.run")(state, "turtledemo.run", TURTLES);   // source-arg form
  await resolveFn(state, "view.refresh")(state);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "dom.paint");
  return state;
}
