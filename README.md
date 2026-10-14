# shlink-dicom

A proposal for sharing complete DICOM imaging studies through SMART Health Links. The images are hosted on a server that cannot read them, and a client can read any series or byte range.

- [PROPOSAL.md](PROPOSAL.md): the proposal, from goals through formats, fetch contract, security and open questions.
- `reference/series-file.ts`: reference encryption and range decryption for series files (WebCrypto only).
- `reference/test-vector.ts`: prints the test vector in the proposal's Appendix B and checks round trips, range reads and tamper detection. Run with `bun reference/test-vector.ts`.
