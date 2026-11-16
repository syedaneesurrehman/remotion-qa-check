#!/usr/bin/env node
// remotion-qa: run from the root of a Remotion project.
//   node <path>/bin/qa.mjs <module> <ExportName> <durationInFrames> [options]
//   e.g. npx remotion-qa src/Intro Intro 450 --width 1920 --height 1080
// One low-resolution render gives two checks:
//   1. layout probe (DOM): text covered by another element, text over text, text clipped by the frame, low contrast,
//      and (optional) words that are not in --script
//   2. frame fill (pixels): stretches where the frame is nearly empty, and frames where everything sits in a small area
// An issue counts only when it persists for 3 samples in a row (15 frames at the default --every 5), so entrances and
// crossfades are ignored. Exit code 1 when anything persistent is found.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const take = (flag, dflt = null) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const width = Number(take("--width", 1920));
const height = Number(take("--height", 1080));
const fps = Number(take("--fps", 30));
const every = Number(take("--every", 5));
const range = take("--range");
const scriptPath = take("--script");
const allowArg = take("--allow", "");
const maxEmptyRun = Number(take("--max-empty-run", 1.5));
const [mod, exportName, frames] = args;
if (!mod || !exportName || !/^\d+$/.test(frames || "")) {
  console.log("usage: remotion-qa <module> <ExportName> <durationInFrames> [--width 1920 --height 1080 --fps 30 --every 5 --range a-b --script text.txt --allow 'w,w' --max-empty-run 1.5]");
  process.exit(2);
}

// 1. entry file inside the project, so the bundler resolves the project's own imports
const dir = ".remotion-qa";
mkdirSync(dir, { recursive: true });
copyFileSync(join(HERE, "../src/OverlapProbe.tsx"), join(dir, "OverlapProbe.tsx"));
const modRel = "../" + mod.split("\\").join("/").replace(/^\.?\//, "").replace(/\.(tsx?|jsx?)$/, "");
writeFileSync(
  join(dir, "entry.tsx"),
  `import React from "react";
import { Composition, registerRoot } from "remotion";
import { OverlapProbe } from "./OverlapProbe";
import { ${exportName} as Target } from "${modRel}";
const Wrapped: React.FC = () => (<OverlapProbe every={${every}}><Target /></OverlapProbe>);
registerRoot(() => (<Composition id="Probe" component={Wrapped} durationInFrames={${frames}} fps={${fps}} width={${width}} height={${height}} />));
`,
);

// 2. one render at quarter scale: frames for the fill check, console lines for the probe
const out = mkdtempSync(join(tmpdir(), "remotion-qa-"));
const cmd = `npx remotion render ${join(dir, "entry.tsx")} Probe --sequence --image-format=jpeg --scale=0.25 --log=verbose ${range ? `--frames=${range}` : ""} --output="${out}"`;
const r = spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 1 << 28 });
rmSync(dir, { recursive: true, force: true });
const log = (r.stdout || "") + (r.stderr || "");
if (r.status !== 0) {
  console.log("render failed:\n" + log.slice(-1500));
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
}

// 3. layout probe
let allowed = null;
if (scriptPath) {
  allowed = new Set();
  const add = (t) => String(t || "").toLowerCase().split(/[^a-z0-9']+/).forEach((w) => w && allowed.add(w.replace(/'s$/, "")));
  add(readFileSync(scriptPath, "utf8"));
  add(allowArg);
}
const wordOk = (w, last) => {
  if (w.length < 3 || /^[0-9.,:%$+\-]+$/.test(w)) return true;
  if (allowed.has(w) || allowed.has(w.replace(/'s$/, ""))) return true;
  if (last) for (const a of allowed) if (a.startsWith(w)) return true; // text typing on
  return false;
};
const seen = new Map();
const info = new Map();
const copy = new Map();
const sampled = new Set();
for (const line of log.split("\n")) {
  const i = line.indexOf("PROBE {");
  if (i < 0) continue;
  let body = line.slice(i + 6);
  body = body.slice(0, body.lastIndexOf("}") + 1).split('\\"').join('"');
  let p;
  try { p = JSON.parse(body); } catch { continue; }
  sampled.add(p.f);
  for (const it of p.issues) {
    if (it.type === "seen") {
      if (!allowed) continue;
      const words = it.text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
      const bad = words.filter((w, k) => !wordOk(w, k === words.length - 1));
      if (bad.length) {
        if (!copy.has(it.text)) copy.set(it.text, { frames: new Set(), bad });
        copy.get(it.text).frames.add(p.f);
      }
      continue;
    }
    const sig = `${it.type}|${it.text}|${it.other || ""}`;
    if (!seen.has(sig)) seen.set(sig, new Set());
    seen.get(sig).add(p.f);
    if (it.info) info.set(sig, it.info);
  }
}
const longest = (set) => {
  // longest run of samples exactly `every` frames apart
  const fs = [...set].sort((a, b) => a - b);
  let best = 1, cur = 1, st = fs[0], bs = fs[0], be = fs[0];
  for (let k = 1; k < fs.length; k++) {
    if (fs[k] - fs[k - 1] === every) {
      cur++;
      if (cur > best) { best = cur; bs = st; be = fs[k]; }
    } else { cur = 1; st = fs[k]; }
  }
  return { n: best, a: bs, b: be };
};
const issues = [];
for (const [sig, set] of seen) {
  const { n, a, b } = longest(set);
  if (n < 3) continue;
  const [type, text, other] = sig.split("|");
  issues.push(
    type === "low-contrast"
      ? `low-contrast: "${text}" has ${info.get(sig)} (needs 4.5:1, or 3:1 at 40px+)  (frames ${a}-${b})`
      : `${type}: "${text}"${other ? ` is covered by / overlaps ${other}` : ""}  (frames ${a}-${b})`,
  );
}
for (const [text, v] of copy) {
  const { n, a, b } = longest(v.frames);
  if (n >= 3) issues.push(`unscripted-text: "${text}" has words not in ${scriptPath} (${v.bad.join(", ")})  (frames ${a}-${b})`);
}

// 4. frame fill from the rendered frames
const files = readdirSync(out).filter((f) => f.endsWith(".jpeg") || f.endsWith(".jpg")).sort();
const step = 15;
const THR = 22;
const startFrame = range ? Number(range.split("-")[0]) : 0;
const pct = (arr, p) => { arr.sort((a, b) => a - b); return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]; };
const rows = [];
for (let k = 0; k < files.length; k += step) {
  const { data, width: W, height: H } = jpeg.decode(readFileSync(join(out, files[k])), { useTArray: true });
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  let ink = 0;
  const xs = [], ys = [];
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const v = Math.abs(g[y * W + x + 1] - g[y * W + x]) + Math.abs(g[(y + 1) * W + x] - g[y * W + x]);
      if (v > THR) { ink++; xs.push(x); ys.push(y); }
    }
  }
  const fill = ink > 20 ? ((pct(xs, 0.995) - pct(xs, 0.005)) * (pct(ys, 0.995) - pct(ys, 0.005))) / (W * H) : 0;
  rows.push({ t: (startFrame + k) / fps, share: ink / (W * H), fill });
}
rmSync(out, { recursive: true, force: true });
const body = rows.filter((r) => r.t >= 0.3);
const empty = body.map((r) => r.share < 0.0035);
const sparse = body.map((r) => r.fill < 0.18);
let best = 0, cur = 0, st = 0, bestAt = 0;
empty.forEach((e, i) => {
  if (e) { if (!cur) st = i; cur++; if (cur > best) { best = cur; bestAt = st; } } else cur = 0;
});
const emptyS = (best * step) / fps;
const sparseShare = body.length ? sparse.filter(Boolean).length / body.length : 0;
const fillBad = emptyS > maxEmptyRun || sparseShare > 0.45;

console.log(`probe sampled ${sampled.size} frames; persistent text issues: ${issues.length}${allowed ? "" : " (script check off: no --script)"}`);
issues.forEach((l) => console.log(" - " + l));
console.log(`frame fill: ${body.length} samples, empty ${empty.filter(Boolean).length}, sparse ${(sparseShare * 100).toFixed(0)}%, longest empty run ${emptyS.toFixed(1)}s${best ? ` at t=${body[bestAt].t.toFixed(1)}s` : ""}`);
if (fillBad) console.log("FRAME-FILL FAIL: a near-empty stretch, or most frames use only a small part of the frame");
if (issues.length || fillBad) {
  console.log("\nCHECK FAILED");
  process.exit(1);
}
console.log("\nCHECK PASSED");
