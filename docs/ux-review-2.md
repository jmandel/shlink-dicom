# Demo UX review 2

From the codec coordinator, after checking round 1. Everything from review 1 is in, verified with fresh screenshots and with `/api/demo-shares`:
- the default demo is the public Brain MRI + Wrist set only;
- "Demo Patient" is shown in place of the name;
- labels match what they open;
- there is an intro band;
- the tagline reads "End-to-End Encrypted";
- the phone layout stacks;
- the console is clean.

Remaining items, smallest first.

1. **The page scrolls by itself on load.** At 390×844 the page loads already scrolled (`window.scrollY` is 143 about 2.5 s after load), so the header and the start of the intro are off screen. On desktop the series list also jumps so that the top card is cut off. This is probably `scrollIntoView()` on the active series card. Scroll only the list container instead (set `scrollTop`/`scrollLeft` of the container), and never scroll the window.
2. **Auto window/level on MR.** The display shows `WL 6862 / WW 13724`, which looks like a min–max window. For the first display:
   - use the instance's own Window Center/Width (0028,1050/1051) when present, taking the first value when there are several;
   - otherwise use a percentile window over the frame's pixels (about the 1st to 99th percentile);
   - keep "Auto W/L" as the reset to that same default.
3. **Default series.** The viewer opens on the last series in the list, T1 SE SAG. That's a fine image, but start on the first series and highlight it, or pick a series on purpose and say why in a comment. Combined with item 1, the list should then start at the top.
4. **Intro band.**
   - Show it on the Viewer tab only.
   - Once dismissed, keep it dismissed: `localStorage`, wrapped in try/catch.
   - While it is visible on desktop, hide the duplicate demo buttons in the header, or drop the ones in the band, so each choice appears once.
5. **Share tab wording.** For a public demo, the copy should say what each control does:
   - "Mint SMART Health Link" → "Create link".
   - "End /cap/ Sessions" → "End open sessions".
   - "Take Offline" is fine.
   - "Active Sandbox Share: -Ip8GeQ… (2 studies ready)" → "Your sandbox: 2 studies", with the id in a tooltip.
6. **How it works.** The Bundle URL is cut off mid-word ("…/bundle.jw"). Let it wrap, or show a shortened middle with a copy button.

**Check:** retake screenshots at 1440×900 and 390×844, and confirm `window.scrollY === 0` after load at both sizes. Reply with a short summary.
