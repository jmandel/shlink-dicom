// The reading sessions, one per kind of study: what a person does, at a person's pace. Every step
// is fixed (no randomness), so two builds see exactly the same session.
//
// A session is a list of operations. Each operation starts with an input and ends when the
// right pixels are on screen (see run.mjs, `measure`):
//   open      click the study card → its first picture (slice, slide tile, video frame)
//   step      one slice of a scrub → that slice (or a later one of the same scrub) drawn
//   jump      straight to a far slice → that slice drawn
//   switch    another series from the strip → its first slice drawn
//   mpr       the first reformat, then slab changes → the plane drawn
//   play      play → the frame moves on; then frames shown in a few seconds
//   fit/zoom/pan   slide views → every tile the view needs is on screen
//
// `study` matches the study card's text. `share` says which of the two shares holds it.

/** Scrub pace (slices per second): a slow read, a quick flick, and a back-and-forth. */
export const PACE = { slow: 8, fast: 25, rock: 15 };

const scrubSeries = (o = {}) => [
  { op: "scrub", label: "scrub-slow", from: "start", count: o.slow ?? 24, pace: PACE.slow },
  { op: "scrub", label: "scrub-fast", from: "here", count: -(o.fast ?? 24), pace: PACE.fast },
  { op: "rock", label: "rock", span: 8, times: 3, pace: PACE.rock },
  { op: "pause", ms: 1500 },
  { op: "jump", label: "jump-far" },
];

export const SESSIONS = {
  // The sample (Josh Example plus the CPTAC-LUAD slide).
  mri: { share: "sample", study: /BRAIN/i, steps: [{ op: "open" }, ...scrubSeries({ slow: 16, fast: 16 }), { op: "switch", to: 1 }, { op: "switch", to: 2 }] },
  ct: {
    share: "sample",
    study: /ABDOMEN/i,
    steps: [{ op: "open" }, ...scrubSeries({ slow: 30, fast: 30 }), { op: "switch", to: 1 }, { op: "switch", to: -1 }, { op: "mpr", plane: "coronal", slabs: [10, 20] }],
  },
  cr: { share: "sample", study: /WRIST LEFT/i, steps: [{ op: "open" }, { op: "switch", to: 1 }, { op: "switch", to: 1 }] },
  slide: { share: "sample", study: /Histopath/i, steps: slideSteps() },
  // The second share (perf/sessions/README.md, Data).
  us: { share: "extras", study: /3D Rendering/i, steps: [{ op: "open" }, { op: "play", seconds: 4 }, ...scrubSeries({ slow: 16, fast: 16 })] },
  enhct: { share: "extras", study: /^CT$/, steps: [{ op: "open" }, ...scrubSeries({ slow: 30, fast: 30 }), { op: "mpr", plane: "sagittal", slabs: [10] }] },
  mg: { share: "extras", study: /MG_Chest/, steps: [{ op: "open" }, { op: "scrub", label: "views", from: "here", count: 6, pace: 1 }] },
  tomo: { share: "extras", study: /TOMOSYNTHESIS/, steps: [{ op: "open" }, ...scrubSeries({ slow: 20, fast: 20 })] },
  dx: { share: "extras", study: /FLAT PLATE/, steps: [{ op: "open" }] },
  slidej2k: { share: "extras", study: /Histopathology/, steps: slideSteps() },
  slidejxl: { share: "jxl", study: /./, steps: slideSteps() },
  video: { share: "extras", study: /Test video/, steps: [{ op: "open" }, { op: "play", seconds: 4 }] },
};

/** Fit, then three regions at full resolution, each followed by four half-screen pans. */
function slideSteps() {
  const regions = [
    [0.3, 0.4],
    [0.6, 0.55],
    [0.45, 0.7],
  ];
  const pans = [
    [0.5, 0],
    [0, 0.5],
    [-0.5, 0],
    [0, -0.5],
  ];
  const steps = [{ op: "open" }, { op: "fit" }];
  for (const [x, y] of regions) {
    steps.push({ op: "zoom", x, y });
    for (const [dx, dy] of pans) steps.push({ op: "pan", dx, dy });
  }
  return steps;
}
