// A deliberately flawed slide used to demo remotion-qa.
// Frames 0-89 have overlapping, low-contrast and clipped text; frames 90-239 show one tiny label in an empty frame.
import React from "react";
import { AbsoluteFill, Sequence } from "remotion";

const Crowded: React.FC = () => (
  <AbsoluteFill style={{ background: "#101828", fontFamily: "sans-serif" }}>
    <div style={{ position: "absolute", left: 120, top: 200, fontSize: 140, fontWeight: 800, color: "#ffffff" }}>QUARTERLY REVENUE</div>
    <div style={{ position: "absolute", left: 130, top: 260, fontSize: 90, fontWeight: 800, color: "#ffdd55" }}>UP 40 PERCENT</div>
    <div style={{ position: "absolute", left: 120, top: 520, fontSize: 64, color: "#1a2438" }}>Hard to read grey on navy</div>
    <div style={{ position: "absolute", left: 1500, top: 800, fontSize: 120, fontWeight: 800, color: "#ffffff" }}>CLIPPED OFF EDGE</div>
  </AbsoluteFill>
);

const Empty: React.FC = () => (
  <AbsoluteFill style={{ background: "#101828", fontFamily: "sans-serif" }}>
    <div style={{ position: "absolute", left: 900, top: 520, fontSize: 32, color: "#ffffff" }}>small</div>
  </AbsoluteFill>
);

export const BadSlide: React.FC = () => (
  <AbsoluteFill>
    <Sequence from={0} durationInFrames={90}><Crowded /></Sequence>
    <Sequence from={90} durationInFrames={150}><Empty /></Sequence>
  </AbsoluteFill>
);
