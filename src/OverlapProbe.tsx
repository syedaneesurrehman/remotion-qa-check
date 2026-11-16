// remotion-qa-check probe. Wraps a composition and, every Nth rendered frame, logs layout problems read from the DOM:
//   - text partly or fully covered by another element (a photo over a card, a bar over a label)
//   - text overlapping other text
//   - text clipped by the composition frame, and text with low contrast
// Output lines look like  PROBE {"f":105,"issues":[...]}  and are collected by bin/qa.mjs.
import React, { useLayoutEffect, useRef } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";


const effOpacity = (el: Element | null): number => {
  let o = 1;
  for (let e = el; e; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.visibility === "hidden" || s.display === "none") return 0;
    o *= parseFloat(s.opacity || "1");
  }
  return o;
};

// Does this element visibly paint over what is behind it? Border/outline-only frames, faint tints and light gradient bands do not count.
const alphaOf = (c: string): number => {
  const m = c.match(/rgba?\(([^)]+)\)/g);
  if (!m) return c === "transparent" ? 0 : 1;
  return Math.max(...m.map((x) => { const p = x.replace(/[^0-9.,]/g, "").split(","); return p.length > 3 ? parseFloat(p[3]) : 1; }));
};
const paintsOver = (el: HTMLElement): boolean => {
  if (["IMG", "CANVAS", "VIDEO"].includes(el.tagName)) return true;
  if (el instanceof SVGElement) return true;
  const s = getComputedStyle(el);
  const bgA = alphaOf(s.backgroundColor);
  const bgImg = s.backgroundImage === "none" ? 0 : s.backgroundImage.includes("gradient") ? alphaOf(s.backgroundImage) : 1;
  return Math.max(bgA, bgImg) > 0.5;
};

const describe = (el: Element): string => {
  const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 22);
  const tag = el.tagName.toLowerCase();
  return t ? `<${tag}> "${t}"` : `<${tag}>`;
};


// ---- contrast: text colour against the nearest opaque background found in its ancestors (unknown for photos/gradients: skipped)
const parseColor = (c: string): number[] | null => {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
};
const lum = (c: number[]): number => {
  const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const over = (top: number[], bottom: number[]): number[] => {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
};
const backgroundOf = (el: Element): number[] | null => {
  const layers: number[][] = [];
  for (let e: Element | null = el; e; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.backgroundImage !== "none") return null; // photo / gradient: unknown
    const c = parseColor(s.backgroundColor);
    if (c && c[3] > 0) {
      layers.push(c);
      if (c[3] >= 0.99) break;
    }
  }
  if (!layers.length || layers[layers.length - 1][3] < 0.99) return null;
  let acc = layers[layers.length - 1];
  for (let i = layers.length - 2; i >= 0; i--) acc = over(layers[i], acc);
  return acc;
};
const contrastOf = (el: Element): number | null => {
  const bg = backgroundOf(el);
  const fg = parseColor(getComputedStyle(el).color);
  if (!bg || !fg) return null;
  const f = over(fg, bg);
  const l1 = lum(f);
  const l2 = lum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

type T = { el: Element; text: string; r: DOMRect; full: string };

const scan = (root: HTMLElement, FRAME_W: number, FRAME_H: number) => {
  const issues: { type: string; text: string; other?: string; info?: string }[] = [];
  const texts: T[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = (n.textContent || "").trim();
    const el = n.parentElement;
    if (!s || !el || ["SCRIPT", "STYLE"].includes(el.tagName)) continue;
    if (effOpacity(el) < 0.35) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    texts.push({ el, text: s.slice(0, 22), r, full: s.slice(0, 140) });
  }
  // every visible string (for the copy-provenance check) and low contrast
  for (const t of texts) {
    if (effOpacity(t.el) >= 0.5) issues.push({ type: "seen", text: t.full });
    if (effOpacity(t.el) >= 0.9 && /[A-Za-z0-9]/.test(t.full)) {
      const ratio = contrastOf(t.el);
      const size = parseFloat(getComputedStyle(t.el).fontSize);
      if (ratio !== null && ratio < (size >= 40 ? 3 : 4.5)) issues.push({ type: "low-contrast", text: t.text, info: ratio.toFixed(1) + ":1 at " + Math.round(size) + "px" });
    }
  }
  const stopped: HTMLElement[] = [];
  for (const t of texts) {
    const { r } = t;
    const cx = r.left + r.width / 2;
    // clipped by the frame (only text that is mostly on screen, i.e. not entering from outside)
    const visW = Math.min(r.right, FRAME_W) - Math.max(r.left, 0);
    if (visW > 0 && (r.left < -2 || r.right > FRAME_W + 2 || r.top < -2 || r.bottom > FRAME_H + 2) && visW / r.width > 0.3) {
      issues.push({ type: "clipped-by-frame", text: t.text });
    }
    // covered by another element
    let covered = 0;
    let by = "";
    const pts: number[][] = [];
    for (const kx of [0.2, 0.5, 0.8]) for (const ky of [0.25, 0.75]) pts.push([kx, ky]);
    for (const [k, ky] of pts) {
      const x = Math.min(FRAME_W - 1, Math.max(0, r.left + r.width * k));
      const y = Math.min(FRAME_H - 1, Math.max(0, r.top + r.height * ky));
      let top = document.elementFromPoint(x, y) as HTMLElement | null;
      for (let i = 0; i < 8 && top && !t.el.contains(top) && !top.contains(t.el); i++) {
        const tr = top.getBoundingClientRect();
        const big = tr.width * tr.height > 0.5 * FRAME_W * FRAME_H; // vignette / grain / full-screen overlays are not occluders
        if (effOpacity(top) < 0.3 || big || !paintsOver(top) || top.tagName === "HTML" || top.tagName === "BODY") {
          top.style.pointerEvents = "none";
          stopped.push(top);
          top = document.elementFromPoint(x, y) as HTMLElement | null;
        } else break;
      }
      if (top && root.contains(top) && !t.el.contains(top) && !top.contains(t.el)) {
        covered++;
        by = describe(top);
      }
    }
    if (covered >= 1) issues.push({ type: "text-covered", text: t.text, other: by });
    void cx;
  }
  stopped.forEach((e) => (e.style.pointerEvents = ""));
  // text over text
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 0 || h <= 0) continue;
      const small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if ((w * h) / small > 0.2) issues.push({ type: "text-over-text", text: a.text, other: b.text });
    }
  }
  return issues;
};

export const OverlapProbe: React.FC<{ children: React.ReactNode; every?: number }> = ({ children, every = 5 }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (f % every !== 0 || !ref.current) return;
    let issues: ReturnType<typeof scan> = [];
    try {
      issues = scan(ref.current, width, height);
    } catch (e) {
      console.log("PROBE-ERR " + String(e));
    }
    console.log("PROBE " + JSON.stringify({ f, issues }));
  });
  return (
    <AbsoluteFill>
      <div ref={ref} style={{ position: "absolute", inset: 0 }}>
        {children}
      </div>
    </AbsoluteFill>
  );
};
