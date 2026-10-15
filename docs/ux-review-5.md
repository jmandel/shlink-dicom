# Demo UX review 5: phone

Checked at 390×844 with touch emulation (`isMobile`, `hasTouch`, device scale factor 2) in all three tabs and with the passcode demo. Page width is correct: no horizontal page overflow, and the series strip is the only intended horizontal scroller. There are no console errors. The layout order is good: image first, controls next, series strip after.

What's left is mostly about touch.

1. **Touch gestures on the image.** The stage only listens for `wheel` (main.ts:665), so on a phone the only way to change slice or window/level is the thin sliders. Use Pointer Events, with `touch-action: none` on the stage and nowhere else:
   - one-finger vertical drag: change slice (about one slice per 8–10 px), with the slice badge updating as it goes;
   - one-finger horizontal drag: nothing for now, so the page can still be swiped where that matters;
   - two-finger drag, or press-and-hold then drag: window/level (horizontal = width, vertical = level);
   - pinch: zoom, with pan while zoomed;
   - double-tap: reset zoom and window/level.

   Keep mouse behaviour on desktop as it is (wheel = slice). Make sure scrolling the page still works when the gesture starts outside the image.
2. **Touch targets.** Most buttons are 22 px tall: the tabs, demo buttons, Paste, Back to Viewer, Simulate Bit-Flip, Reset Sandbox. The checkboxes are 13 px, and the W and L sliders are short and thin.
   - Under `(pointer: coarse)`, give buttons, tabs and selects a minimum height of 44 px.
   - Make checkboxes 22–24 px, inside a label whose whole row is tappable.
   - Give range inputs a 28–32 px thumb.
   - Spacing between adjacent buttons should be at least 8 px.
3. **The intro band takes about 40% of the first screen on a phone,** pushing the image down. On narrow screens, show one short line ("Encrypted medical imaging over a SMART Health Link") and keep the demo buttons in one row. The full sentence can sit behind "What is this?".
4. **The passcode demo never shows the passcode prompt.** It auto-fills the hint (main.ts:182), so on tapping "Passcode Demo (1234)" the study simply loads, and the visitor never sees the passcode step that the demo exists to show. Show the prompt pre-filled with 1234, or with "Hint: 1234" beside it, and let the visitor submit it.
5. **Share tab on a phone.**
   - The passcode field placeholder is cut off ("Optional Passcode (enab…"); use "Passcode (optional)".
   - Rename "Long-lived ( L )" to "Allow updates", with the L flag in a tooltip.
   - On link cards, make the QR thumbnail tap to a full-screen QR, which is how a phone user would hand a link to someone.
   - Put "Copy URL" first, since a phone user will share by copying.
6. **Viewport details.**
   - Replace `100vh` (styles.css:27, :1179) with `100dvh`, keeping `100vh` as a fallback, so mobile browser toolbars don't cut off the bottom bar.
   - Add `viewport-fit=cover` and `env(safe-area-inset-*)` padding on the header and bottom bar for phones with notches.
7. **Landscape.** Check 844×390. In landscape the image should fill the height, with the series strip and controls beside it or collapsed.

**Check:**
- Screenshots at 390×844, 360×740 and 844×390, all with touch emulation.
- Confirm by script:
  - a vertical drag on the stage changes the slice number;
  - every visible control is at least 44 px tall under coarse pointer;
  - there is still no horizontal page overflow.

Reply with a short summary.
