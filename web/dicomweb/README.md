# Browser DICOMweb adapter

The standalone [OHIF demo](https://shlink-dicom.exe.xyz/demos/ohif/) and [Cornerstone3D demo](https://shlink-dicom.exe.xyz/demos/cornerstone/) open the server's public sample automatically. Each accepts another SMART Health Link and an optional passcode. The native DICOMweb image loaders and decoders in OHIF 3.13.13 and Cornerstone3D 5.13.1 render the stored images.

OHIF keeps its native interactions: expand a study, then **double-click** a series thumbnail. The pinned bundle has one guarded `StudyItem` fix: the accordion uses the same controlled expansion state as its thumbnails. Without this, closing a study while its metadata loads lets a late display-set update desynchronize the chevron and content; reopening shows an empty panel and collapsing briefly flashes the thumbnails.

Cornerstone shows a study/series browser alongside the viewport and reports the current image number. Native scroll, window/level, pan and zoom bindings are unchanged. Two low-priority requests preload up to ten nearby slices, with a neighborhood budget estimated from the current image's decoded size (32 MiB) and a 128 MiB decoded-image cache. Scrolling or changing series replaces pending prefetch work; already running requests may finish. Non-image series and whole-slide microscopy remain visible in the browser with an explanation when selected; the main SHLink DICOM viewer handles those objects.

Run `bun web/build.ts`, then serve `dist/web` over HTTPS or localhost. The demos are `/demos/ohif/` and `/demos/cornerstone/`. A separate static host can use `?api=https://shlink-dicom.exe.xyz` for the public sample list; upstream encrypted files must allow CORS. The paths work under a site prefix as well as at the origin root. OHIF's release archive is pinned by SHA-512; `build.ts` checks and relocates its application, worker and CSS asset paths. All viewer assets are served locally, with no runtime CDN dependency.

## Embedding

Serve the built files in `dist/web/demos/` alongside a page within that directory's scope:

```js
import { openDicomweb } from './shlink-dicomweb.js';

const session = await openDicomweb(link, { passcode, signal });
// session.root is an opaque, same-origin URL ending in '/'.
// Configure an existing viewer's qidoRoot and wadoRoot with this URL.
const studies = await (await fetch(session.root + 'studies')).json();

// When replacing the share or closing the viewer:
session.dispose();
```

`openDicomweb` waits for service-worker control before returning. `session.studies` contains study/series summaries. For an embedded same-origin viewer, call `session.connectFrame(iframe)` and forward the service worker's `shlink-dicomweb-v1` messages and their port from the child to its parent, as `ohif-config.js` does. Its return value disconnects the frame. The parent validates the frame and session before forwarding anything. The OHIF demo creates a fresh iframe when changing studies so OHIF's UID-keyed metadata never carries across different shares.

This is an in-browser endpoint for controlled pages on the viewer's origin. It is not a server endpoint usable by curl, a PACS, or an unrelated hosted OHIF instance. No SHLink wire-format or server change is required.

## Requests and lifetime

The service worker is a stateless HTTP router. The owning page has one dedicated worker per session containing the opened share, its immutable inventory, resolver, ciphertext cache and header cache. Requests pass through two MessagePorts, with one response chunk per pull, cancellation and a two-minute idle timeout. Closing a session terminates its worker. Plaintext and keys are not written to IndexedDB, CacheStorage or URL query parameters. DICOMweb responses carry `Cache-Control: no-store`.

Stopping/restarting the service worker does not lose the session. A different tab cannot use the first tab's opaque endpoint; its local dispatcher answers 410. The existing resolver still owns passcodes, authenticated byte ranges and capability refresh. Both fetch and XHR pass through the service worker.

Supported read-only resources under `session.root`:

| Resource | Response |
| --- | --- |
| `studies`, `studies/{study}/series` | QIDO DICOM JSON from the retained inventory |
| `studies/{study}/instances`, `studies/{study}/series/{series}/instances` | QIDO DICOM JSON from instance headers |
| Study, series or instance path + `/metadata` | Typed DICOM JSON, including sequences and functional groups |
| Instance path + `/frames/1,2,…` | WADO-RS multipart frame payloads; one-based frame numbers |
| Instance path + `/bulk/7FE00010` | Multipart Pixel Data, one frame per part |
| Study, series or instance path | Multipart original Part 10 files; an instance with `Accept: application/dicom` returns the raw original |

Query matching supports common patient/study/series/instance fields, UID lists, wildcards, study-date ranges, `limit` and `offset`. It is a practical QIDO/WADO subset, not a complete DICOMweb server. It does not implement STOW, rendered-image endpoints, fuzzy matching or general cross-study search at every resource level.

Frame responses preserve the transfer syntax and codec payload; DICOM item headers are removed from encapsulated frames. Native one-bit frames are repacked and YBR 422 uses its stored two-sample layout. Requested incompatible transfer syntaxes receive 406. The adapter does not transcode. The two demos are intended for image stacks; support for other SOP classes depends on the viewer. Deflated datasets, floating-point pixels, video and JPEG 2000 Part 2 frames are available as original downloads, not frame rendering through this adapter. Header reads have a 32 MiB budget; individual encoded frames have a 256 MiB budget. Original instance retrieval streams with a 4 MiB ciphertext budget regardless of instance size.

Metadata uses dcmjs's full VR dictionary and preserves PN/SQ structure. Identity fields are checked against the encrypted inventory. Pixel Data is represented by a resolvable bulk-data URI. Metadata requests share bounded concurrent header reads; an individual cancelled consumer does not discard a header another consumer is using.

The MIME representations follow [DICOM PS3.18 §8.7.3](https://dicom.nema.org/medical/dicom/current/output/chtml/part18/sect_8.7.3.html). Pinning the upstream viewers keeps changes to their integration and asset layout reviewable.

## Verification

```sh
bun test test/dicomweb.test.ts
BASE=http://127.0.0.1:8861 API=https://shlink-dicom.exe.xyz \
  CHECK_OUT=/tmp/dicomweb-check node web/checks/dicomweb-check.mjs
```

`web/checks/dicomweb-navigation-check.mjs` uses the same `BASE`, `API` and `CHECK_OUT` variables. It checks every public-sample CT/MR/CR series, rapid series selection, ten wheel steps with actual image IDs, narrow layouts, the OHIF late-metadata expansion race, keyboard expansion and double-click navigation across studies.

The browser check verifies nonblank CT and MR pixels in both actual viewers, stored JPEG Lossless frame retrieval, a stopped and restarted service worker, two-tab isolation, cancellation, passcode links and narrow Cornerstone layouts. It saves screenshots and structured results. OHIF's VTK emits a `zero width color range` diagnostic for the sample's reconstructed dose-report thumbnail, whose original Window Width is 1; the check records that known upstream diagnostic separately without changing the image metadata. The unit suite verifies native pixel bytes, metadata identity, typed sequences, frame boundaries and the port transport's backpressure and failure behavior.
