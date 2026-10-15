# Demo UX review 1

From the codec coordinator, 15 Oct 2026. Based on screenshots of http://localhost:3333 at 1440×900 and 390×844, in all three views. The viewer and the "How the Spec Works" page are already strong. Work through the items below in order, one small step at a time, and re-check each step in the browser before moving on.

## P0: data and privacy

1. **Real identity on the landing page.** The app opens straight onto the CT abdomen/pelvis seeded from `~/Downloads/DICOM-…zip`, showing the real patient name and birth date. Unlike the brain MRI and wrist set (`jmandel/my-health-data`), that export has not been published. Until Josh says otherwise:
   - Keep the Downloads studies local-only: never commit them, never deploy them, and don't put them in a default or public demo share.
   - Make the default demo the public Brain MRI + Wrist set.
   - In demo mode, display a placeholder name and birth date (for example "Demo Patient", birth date hidden) unless a setting turns real values on. Never change the DICOM bytes; the files must stay byte-identical.
2. **Labels that don't match the data.** The "Brain MRI + Wrist (47 MB)" button opens a 5-study, 239 MB share that starts on the CT. A button's label must describe exactly what it opens, and the first study shown must be the one the label names.

## P1: first impression

3. **No introduction.** A first-time visitor lands in a viewer and has no idea what this is. Add a short intro state, shown before a link is opened or as a dismissible band:
   - one plain sentence on what this is (for example "View and share full-quality medical imaging through a SMART Health Link. Images are encrypted end to end; the server stores only ciphertext.");
   - the demo choices;
   - "paste a link".

   Lead with what the person can do; the mechanics live in tab 2.
4. **"Zero-Knowledge" in the tagline.** That term means zero-knowledge proofs to many readers, and isn't accurate here. Use "end-to-end encrypted" or "the host stores only ciphertext". Keep all copy plain and factual: no hype words.
5. **Patient name in DICOM format.** Show "MANDEL^JOSHUA^^" as "Joshua Mandel", by splitting on `^` and trimming empty parts.
6. **Truncated study picker.** It reads "CT ABDOMEN/PELVIS W CON (7 serie…". Widen it, or put the series count on its own line.

## P1: phone layout (390 px wide is broken)

7. **Header.** At phone width the header wraps into many lines, and the tabs and demo buttons are squeezed. Collapse the demo buttons into one "Open demo" menu, and make the tabs short ("Viewer · How it works · Share").
8. **Viewer.** The series list and the canvas sit side by side, so the image is about 120 px wide and the overlays overlap. Below about 800 px:
   - stack them: image first, then the series as a horizontal thumbnail strip, or behind a "Series" button;
   - let the HUD text wrap into the corners without overlapping;
   - stack the bottom bar's controls.

## P2: polish

9. **How the Spec Works.**
   - The JSON panels clip long lines horizontally; wrap them, or allow horizontal scrolling with a visible hint.
   - The Bundle URL breaks mid-word.
   - The record map leaves a large empty area until something is hovered; size it to its content.
   - The "Verify Cornerstone & WADO-RS SW Bridge" button is a developer tool. Move it into a collapsed "Developer" section.
10. **Share & Host Lab.**
    - The live log is an empty dark box at first. Show a placeholder such as "Open a link in another tab to see each request the host serves", with an "Open in Viewer" shortcut.
    - The "Upload .zip / .tgz / .dcm…" button text wraps; shorten it to "Upload DICOM…".
11. **Console.** Landing produces a 404 on some resource (possibly the favicon); fix it.
12. **Element id.** `id="record-hover- readout"` in index.html has a space in it.

## How to check

- Rebuild, and take screenshots at 1440×900 and 390×844 of each view: landing, viewer with a demo open, How it works, Share.
- Check the console for errors.
- Make sure each of the three tabs still works with the public demo and with the passcode demo (1234).
- Summarise what changed in PLAN.md or in your reply.
