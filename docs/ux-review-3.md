# Demo UX review 3: the sharing story

Round 2 is verified:
- no scroll on load at either size;
- the viewer opens on the first series;
- window/level comes from the instance's own values, which on this MR are full-range values written by the scanner, so that is correct;
- the intro shows on the Viewer tab only and stays dismissed;
- the Share tab wording is plain;
- the Bundle URL wraps;
- there are no console errors.

This round makes the Share tab tell its story in under a minute: choose what to share, create a link, hand it over, watch it being used, revoke it.

1. **A QR code for each link.** SMART Health Links are meant to be shown as QR codes.
   - Each card under "Active Links" gets a small QR code that enlarges on click.
   - Render it in the page: no external service, and no CDN unless pinned to an exact version.
   - Use error correction level M, as the SHL specification recommends.
   - Label it with the link's label.
2. **"Open in Viewer" opens a new tab.** Then the live host log, in this tab, fills with that tab's range requests as they happen, which is the moment the demo exists for. Each log line should show the link label, not just the link id, so it's clear which link is being read.
3. **Show the subset story.** Make it obvious that a link can carry fewer studies than the share holds:
   - Each link card lists its studies (for example "Upper Extremity only").
   - When a link with a subset is opened, the viewer shows only those studies.
   - Add a one-line hint above "Create link": "Each link has its own key and only the keys for the studies you choose."
4. **Revoking.**
   - After "Revoke", the card stays visible, greyed out, with "Revoked: this link now returns 404", and a button to try it.
   - "Take Offline" shows "Offline: requests return 404 until you bring it back online", with "Bring online".
5. **Passcode links.** On a card for a passcode link, show "Passcode required (attempts left: N)" from the server's counter. Opening it in the viewer prompts for the passcode, as the Passcode Demo does.

**Check:**
1. Create a link for Upper Extremity only.
2. Open it in a new tab and confirm only that study appears and the log shows its requests.
3. Revoke it and confirm the open tab's next request fails with a clear message: the viewer should say "This link was revoked or has expired", not show a raw error.
4. Take screenshots at both sizes.

Reply with a short summary.
