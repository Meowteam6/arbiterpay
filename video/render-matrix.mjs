// Batch render: 3 aspects x 3 languages = 9 MP4s off the one composition.
// Run: node render-matrix.mjs   (after `npm install`)
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const comps = { Square: "square", Vertical: "vertical", Landscape: "landscape" };
const langs = ["en", "zh", "fil"];

mkdirSync("out", { recursive: true });

for (const [comp, tag] of Object.entries(comps)) {
  for (const lang of langs) {
    const out = `out/gohealthme-${lang}-${tag}.mp4`;
    const props = JSON.stringify({ lang });
    const cmd = `npx remotion render src/index.ts ${comp} ${out} --props='${props}'`;
    console.log(`\n> ${cmd}`);
    execSync(cmd, { stdio: "inherit" });
  }
}
console.log("\nDone. 9 renders in ./out");
