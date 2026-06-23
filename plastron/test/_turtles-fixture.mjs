// Shared test fixture: the turtles + turtle_charts worksheets (the content the
// 📊 Turtles document records) as a windowed-worksheet fixture for the sheet-host /
// formula-bar / window suites. Inlined here (the starter .f files were removed when
// readme/keyboard/turtles became origin-user documents).
const TURTLES = `\
=segment(
	cels("turtle_charts", 1, 3,
		geom(0, 0.4, 0.8, 0.6),
		at("a1", '=canvas(300, 200, barchart(turtle_data!A2:A8, turtle_data!B2:B8))'),
		at("b1", '=canvas(300, 200, linechart(turtle_data!A2:A8, turtle_data!C2:C8))'),
		at("c1", '=canvas(300, 200, piechart(turtle_data!A2:A8, turtle_data!D2:D8))')),
	cels("turtle_data", 8, 4,
		geom(0, 0, 0.8, 0.4),
		at("a1", "Species"), at("b1", "Lifespan years"), at("c1", "Top speed km/h"), at("d1", "Eggs per clutch"),
		at("a2", "Galápagos"),   at("b2", "177"), at("c2", "0.3"), at("d2", "10"),
		at("a3", "Leatherback"), at("b3", "45"),  at("c3", "35"),  at("d3", "80"),
		at("a4", "Green sea"),   at("b4", "75"),  at("c4", "32"),  at("d4", "110"),
		at("a5", "Box"),         at("b5", "100"), at("c5", "0.5"), at("d5", "5"),
		at("a6", "Snapping"),    at("b6", "40"),  at("c6", "2"),   at("d6", "30"),
		at("a7", "Painted"),     at("b7", "55"),  at("c7", "1.5"), at("d7", "12"),
		at("a8", "Loggerhead"),  at("b8", "65"),  at("c8", "24"),  at("d8", "100")))
`;

export async function openTurtlesFixture(state, resolveFn) {
  await resolveFn(state, "origin.run")(state, "turtledemo.run", TURTLES);
  await resolveFn(state, "view.refresh")(state);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "dom.paint");
  return state;
}
