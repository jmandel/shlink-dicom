# Demo UX review 4: the recipient's view

Round 3 is verified with a scripted run:
1. Create an "Upper Extremity only" link. Its card shows the subset badge and a QR code.
2. Open it in a new tab. The viewer lists only Upper Extremity, and the Share tab's log shows "[Wrist only test]" requests with 206 ranges.
3. Revoke it. The card greys out and reads "Revoked: this link now returns 404".
4. Reload the viewer. It shows "This link was revoked or has expired."

No page errors anywhere. Two small things remain.

1. **Opening someone else's link.** When the page is opened from a link (a `#shlink:/` hash), the visitor is a recipient, not someone trying the demo:
   - Hide the "Try a demo" intro band.
   - Show one line: "Shared with you: <link label>", using the label from the link payload, plus the study count.
   - Keep the header's demo and paste controls for anyone who wants them.
2. **Failure states in the viewer.** A revoked, expired or offline link, a wrong passcode with no attempts left, or a network failure currently leaves the empty viewer showing, including "Opening SMART Health Link…" in the series list, blank controls and "Slice – / –". Replace the viewer area with one centred message panel:
   - the reason ("This link was revoked or has expired.");
   - what the person can do ("Ask the sender for a new link", or "Try a demo");
   - a "Paste a different link" button.

   Hide the series list, the controls and the export buttons in this state.

**Check:** a revoked link, a passcode link (enter a wrong passcode until the attempts run out), and a normal link. Take screenshots at both sizes. Then reply with a short summary.
