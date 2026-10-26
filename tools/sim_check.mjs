// Headless sanity check of the web simulation: node tools/sim_check.mjs [slug]
import fs from "node:fs";
import { City } from "../docs/js/city.js";
import { Game, Progression } from "../docs/js/game.js";
import { cellIndex } from "../docs/js/grid.js";

const slug = process.argv[2] || JSON.parse(fs.readFileSync("docs/maps/index.json")).procedural[0];
const city = new City(JSON.parse(fs.readFileSync(`docs/maps/${slug}.json`)));
const g = new Game({ city, seed: 1, progress: new Progression(null) });
let t = performance.now();
g.reset();
console.log(slug, "reset ms", (performance.now() - t).toFixed(1), "P", g.P, "cars", g.nCars, "cp", g.cp);
// LZ on the open cell nearest the map centre
let best = null;
for (let y = 300; y < 600 && !best; y += 10) for (let x = 450; x < 750; x += 10) {
  const c = cellIndex(x, y);
  if (city.open[c] && g.lzCells(x, y).length >= 8) { best = [x, y]; break; }
}
g.deployPoint("evac", ...best);
g.deployPoint("infantry", best[0] + 25, best[1]);
console.log("units", g.units.size, "cp", g.cp, g.message);
g.start();
let worst = 0, total = 0, n = 0;
while (g.phase === "running" && g.runTime < 240) {
  t = performance.now();
  g.step(1 / 30);
  const d = performance.now() - t;
  worst = Math.max(worst, d); total += d; n++;
  if (n % 900 === 0) console.log(`t=${g.runTime.toFixed(0)} counts=${g.counts()} rescued=${g.rescued} kills=${g.kills} infected=${g.infected} cars_escaped=${g.carsEscaped} trojans=${g.trojans}`);
}
console.log("phase", g.phase, "t", g.runTime.toFixed(1), "rescued", g.rescued, "sheltered", g.sheltered, "of", g.totalHealthy,
  "avg step ms", (total / n).toFixed(2), "worst", worst.toFixed(1), g.lastResult);
