# Conformance to SMART Imaging Access

This file checks the sandbox against the [SMART Imaging Access IG](https://build.fhir.org/ig/argonautproject/smart-imaging/), CI build of version 0.1.0 dated 2026-09-23. It lists every SHALL and SHOULD on the [Specification](https://build.fhir.org/ig/argonautproject/smart-imaging/specification.html) page, in the [server CapabilityStatement](https://build.fhir.org/ig/argonautproject/smart-imaging/CapabilityStatement-smart-imaging-server.html) and in the two profiles, and says how the sandbox meets it, or why it doesn't. "Test" names the check in `test/e2e.ts` or `test/validate.ts` that covers it.

The sandbox supports the **App Launch** mode only. It does not offer Backend Services.

## Discovery

| Requirement | Level | How the sandbox meets it |
|---|---|---|
| Apps prefer in-band discovery, and may fall back to out-of-band configuration | SHOULD (app) | `test/client.ts` discovers in-band from the clinical base. |
| A Clinical FHIR Server supporting in-band discovery advertises `smart-imaging-access`: top level if it serves ImagingStudy itself, otherwise in `associated_endpoints[].capabilities` | SHALL | `/fhir/.well-known/smart-configuration` lists `/imaging/fhir` in `associated_endpoints` with `smart-imaging-access`. `/imaging/fhir/.well-known/smart-configuration` puts it in the top-level `capabilities`. Test: "discovery: imaging endpoint found via associated_endpoints". |
| App Launch deployments advertise `…/capabilities/app-launch` alongside `smart-imaging-access` for each imaging endpoint | SHALL | Both documents do. |
| The SMART configuration advertises `authorization_code` in `grant_types_supported` and meets SMART App Launch discovery requirements | SHALL | Yes. The documents give `authorization_endpoint`, `token_endpoint`, `capabilities`, `grant_types_supported` and `code_challenge_methods_supported: ["S256"]` (no `plain`). They also give `scopes_supported`, `response_types_supported`, `introspection_endpoint`, `revocation_endpoint` and `token_endpoint_auth_methods_supported`. `issuer` and `jwks_uri` are omitted because `sso-openid-connect` is not offered. There is no `management_endpoint`. |
| Backend Services deployments advertise `…/capabilities/backend-services`, include `client_credentials`, meet asymmetric-auth discovery, and should list `system/ImagingStudy.rs` | SHALL / SHOULD | Not applicable: Backend Services is not offered or advertised. |
| Deployments supporting both modes advertise both capabilities | SHALL | Not applicable. |
| Clients using in-band discovery check the imaging-specific capability for their mode | SHALL (app) | `discover()` requires both `smart-imaging-access` and `…/app-launch` on the same entry. |

## Authorization

| Requirement | Level | How the sandbox meets it |
|---|---|---|
| Deployments support at least one of App Launch and Backend Services | SHALL | App Launch: standalone launch, public clients, PKCE S256. |
| The app presents the access token as a Bearer token for clinical reads, ImagingStudy searches and WADO-RS retrievals | SHALL (app) | `test/client.ts` does. All three servers require it: without a token they return 401 with `WWW-Authenticate: Bearer`. Tests: "…no token: 401". |
| Backend Clients follow SMART Backend Services, support `system/ImagingStudy.rs`, and do not use the client-assertion JWT as a bearer token | SHALL | Not applicable. |
| The Authorization Server and resource servers enforce a Backend client's access restrictions consistently | SHALL | Not applicable. |
| Before serving any imaging FHIR or WADO-RS request: (1) the token is active and issued by the configured Authorization Server for this resource server | SHALL | All servers share one in-memory token store (`validateAccessToken`). Expired, revoked and unknown tokens get 401. Every token is bound to all three resource bases (clinical, imaging, WADO-RS), whichever FHIR base the app sent as `aud`. Each server checks that its own base is in the token's audience, and introspection returns the list as `aud` (Josh's ruling; see item 1 under "Unclear points in the IG"). Tests: "introspection aud lists …", "validator refuses the token at a base outside its aud", "aud=imaging base: token works at …", "expired token: …", "revoked token: …", "made-up token: 401". |
| (2) the token's scopes cover the request, at patient level for App Launch | SHALL | Search needs `s` and read needs `r` on `ImagingStudy` (or `*`), in v2 or v1 syntax. WADO-RS needs `r` on `ImagingStudy`. Patient and DiagnosticReport need their own scopes. So `.rs` covers search plus retrieval, `.s` alone allows search only, and `.r` alone allows retrieval only. A failure gets 403 with `error="insufficient_scope"`. Tests: "Patient-only token: …", "ImagingStudy.s token: search 200", "ImagingStudy.s token: WADO-RS 403", "ImagingStudy.r token: WADO-RS 200", "ImagingStudy.r token: search 403". |
| (3) App Launch: the token's patient context matches the `patient` search parameter, or the owner of the study for WADO-RS; any additional restrictions are enforced | SHALL | Patient mismatch on search or Patient read gets 403. The additional restriction is the consent page's per-study choice, which is enforced in search, read, DiagnosticReport and every WADO-RS path. Tests: "…robin's token: 403", "Negative: study not shared". |
| Missing patient context is not treated as system-level authorization | SHALL | Every grant has a patient. The server never issues a token without one, and never grants `user/` or `system/` scopes. |
| A server not supporting Backend Services does not grant imaging access on the basis of system scopes | SHALL | `system/` scopes are dropped at authorize. A request with only system scopes gets `invalid_scope`. Test: "system/ImagingStudy.rs only: invalid_scope". |
| A server does not serve data when it cannot establish permissions | SHALL | Every check denies by default. |
| Grants are not broadened by combining one grant's context with another's scope | SHALL | Each token has exactly one patient context and one study set, so there is nothing to combine. |
| Before returning a capability Endpoint, the Imaging FHIR Server performs the checks above, limits the capability to authorized data and operations, and binds it to the requesting token | SHALL | `ENDPOINT_MODE=capability`: each capability covers one study and is bound to the grant (the user's consent) behind the token used for the search. It is issued only after the search's checks pass. Binding to the grant rather than to one access token is Josh's reading of "bound to the SMART token": the capability survives a token refresh (see item 5 under "Unclear points in the IG"). |
| The DICOMweb Server validates the token, the capability and their binding | SHALL | `handleWado`: the token check, then that the capability exists, belongs to the token's grant, the grant is still active, the capability has not expired, and it covers the requested study. Tests: "capability URL with another grant's valid token: 403", "…brain study substituted: 403", "capability URL survives a refresh". |
| Internal fetches by the Imaging Server do not expand the client's access | SHALL | Not applicable: there are no internal fetches. |
| The Authorization Server supports SMART App Launch and offers scopes permitting ImagingStudy read | SHALL | `patient/ImagingStudy.rs`, `patient/*.rs` and the v1 forms are in `scopes_supported` and granted. |
| The Authorization Server provides a way for Imaging Servers to validate its tokens: introspection unless another arrangement exists | SHALL | `/auth/introspect` (RFC 7662 with the SMART fields), which requires the resource-server key. In-process servers use the shared validator. Tests: "introspection: …". |
| The Imaging Server enforces the token checks and capability rules; the DICOMweb Server checks every retrieval | SHALL | Yes, on every path, including `/metadata` and the unimplemented `/frames` and `/rendered` (which return 404 only after the token and study checks). |
| The app treats the token as a secret and presents it only to the Authorization Server, the clinical server, the Imaging FHIR server, and WADO-RS endpoints from `Endpoint.address` | SHALL (app) | `test/client.ts` sends it only to those. |

## Finding studies

| Requirement | Level | How the sandbox meets it |
|---|---|---|
| Support `patient`, `patient` + `_lastUpdated`, and `patient` + `identifier` | SHALL | Yes. `patient` accepts `123`, `Patient/123` or the absolute clinical URL. `identifier` accepts `urn:oid:…` or `urn:dicom:uid|urn:oid:…`, comma-separated. `_lastUpdated` accepts the `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `sa`, `eb` and `ap` prefixes at year, month, day or instant precision, and may repeat. Tests: "Search parameters". |
| Support `_include=ImagingStudy:endpoint` | SHALL | Yes. In `external` mode the shared Endpoint is included once (`search.mode = include`). Without `_include`, it is left out. |
| Apps support Endpoints as response-local entries, included resources and contained resources, using Bundle reference resolution | SHALL (app) | `studiesFromBundle()` resolves `#id`, `urn:uuid:`, absolute and relative references (relative ones against the entry's `fullUrl`). The e2e test runs the client against all three server modes and compares every instance. |
| Capability Endpoints use `urn:uuid` `fullUrl`s | SHOULD | Yes, in `capability` mode. |
| Each capability Endpoint is on the same Bundle page as each study referencing it, even without `_include` | SHALL | Yes. Results are never paged. Test: "capability Endpoints are urn:uuid entries, present even without _include". |
| Studies conform to SMART ImagingStudy: a `urn:dicom:uid` identifier, status, patient, modality, and at least one endpoint conforming to SMART WADO-RS Endpoint | SHALL | Built from the DICOM headers, and validated with the HL7 validator (below). |
| Studies carry descriptive detail when available: start time, series and instance counts, per-series metadata | should (lower case in the IG) | `started` is given for the brain MRI (from its description), but the wrist study has no date in any source. `numberOfSeries`, `numberOfInstances` and `description` are given. Each series has `uid`, `number`, `modality`, `description`, `numberOfInstances` and every instance (`uid`, `sopClass`, `number`). |
| Delayed results: the server MAY answer 503 with `Retry-After`; the app SHOULD wait and repeat | MAY / SHOULD (app) | The server never needs to delay. `test/client.ts` retries on 503 with a numeric `Retry-After`. |
| App Launch: a `patient` that does not match the token gets 403, not an empty Bundle | SHALL | Yes. Test: "search patient=jmandel with robin's token: 403". |
| Backend: a patient outside the client's access gets 403 | SHALL | Not applicable. |
| Within an authorized patient, studies and Endpoints the client may not access are omitted, also under `identifier` and `_lastUpdated` | SHALL | Studies left unticked on the consent page are omitted, and so are their Endpoints in `capability` mode. Tests: "search returns only the wrist study", "identifier search for the unshared brain study: empty Bundle". |
| The server returns a searchset Bundle of SMART ImagingStudy resources | SHALL | Yes, with `total`, a `self` link and `search.mode`. |

## Retrieving images

| Requirement | Level | How the sandbox meets it |
|---|---|---|
| The app sends the same SMART access token used for the FHIR request | SHALL (app) | Yes. |
| Capabilities are unguessable or cryptographically protected; their binding is validated; appended paths cannot reach beyond them | SHALL | Each capability is 192 random bits, stored server-side with its grant and study. The study UID in the request path must equal the capability's. |
| Clients treat returned addresses as opaque, preserve their capability information, and protect them | SHALL (app) | The client appends `/studies/{uid}…` to `Endpoint.address` without parsing it. The server redacts capability IDs from its request log. |
| Full-study retrieval with `Accept: multipart/related; type=application/dicom; transfer-syntax=*` | SHALL | Yes. Test: "full-study retrieval (wrist) returns 3 identical instances". |
| Series-level retrieval | SHOULD | Yes. Every series of both studies is retrieved and compared byte for byte. |
| Instance-level retrieval | SHOULD | Yes. Test: "instance-level retrieval returns the identical instance". |
| Frame-level retrieval | SHOULD | Not implemented (404). |
| Rendered images | SHOULD | Not implemented (404). |
| Metadata at study, series and instance level | SHOULD | Yes, as `application/dicom+json`, without Pixel Data (there is no bulk data URI). Test: "study metadata: DICOM JSON for 263 instances". |
| Transfer-syntax negotiation (re-encoding) | SHOULD | Not implemented; the server never transcodes. `transfer-syntax=*` returns the stored bytes, and so does the stored syntax's UID. Any other UID gets `406`. So does an `Accept` with no `transfer-syntax` parameter, because PS3.18 reads that as Explicit VR Little Endian, which compressed studies cannot meet without transcoding. The `406` body says to send `transfer-syntax=*` or the stored UID. This follows Josh's ruling; the IG question is filed as [smart-imaging#3](https://github.com/argonautproject/smart-imaging/issues/3). Tests: "Accept without transfer-syntax: 406 with an explanation", "Accept */*: 406", "Accept with the stored transfer syntax UID (JPEG Baseline): 200", "Accept with a transfer syntax the server does not store: 406". |
| Apps degrade gracefully to full-study retrieval | SHOULD (app) | The client asks for series, which this server supports. A production client should fall back to the full study. |
| The DICOMweb Server performs the token and access checks on every request, including metadata, rendered images, instances and frames, whether or not the client searched first | SHALL | Yes. Direct requests by Study Instance UID are checked against the token's patient and shared studies. Tests: "WADO-RS brain study/series/metadata: 403". |
| Servers document capability lifetime and revocation | SHALL | A capability lives for `CAPABILITY_TTL` (default 900 s). It is bound to the grant, so it keeps working with refreshed tokens from the same grant. It stops working when it expires, or when the grant ends: the refresh token is revoked or expires, or a code replay revokes the grant. Each request also needs a valid access token. Capabilities are never reissued, are kept in memory and do not survive a restart. |
| Capabilities are short-lived | SHOULD | 15 minutes by default. |
| Token and capability validity are checked on each request | SHALL | Yes. |
| A request with an expired or revoked capability gets 403 | SHALL | Yes when the access token is valid. Test: "expired capability with a valid token: 403". When the access token itself has expired or been revoked, the server answers 401 (invalid token) before it looks at the capability. See item 3 under "Unclear points in the IG". Test: "revoked grant: its access token gets 401 at the capability URL". |
| Clients protect tokens and capability URLs | SHALL (app) | Yes. |
| Requests outside the authorized access are denied without DICOM data; a full-study request is never answered with a partial study | SHALL | Access is decided per study, so a study is either released whole or denied with 403. An unknown Study Instance UID gets the same 403 with the same headers and body, so a response does not reveal whether a study exists. Both cases are decided by the same in-memory lookups, so their timing does not differ either. Test: "unshared and unknown studies: same status, headers and body". |
| Retrieval MAY answer 503 with `Retry-After` | MAY | Not needed. |

## Profiles

`test/validate.ts` runs the HL7 FHIR validator (6.9.10) against the IG's current `package.tgz`. It checks:
- the search Bundles in all three Endpoint modes;
- both ImagingStudy resources, and the contained form;
- the Endpoint;
- the Patient;
- the DiagnosticReport Bundle;
- both CapabilityStatements.

Result on 15 Oct 2026, with the sample patient's studies and reports, with `TX=n/a`:
- **Clean:** no errors and no warnings for any ImagingStudy, Endpoint, search Bundle, the Patient, or either CapabilityStatement.
- **The DiagnosticReport Bundle** has two kinds of error, both from tooling rather than from the resources:
  - The validator cannot place `application/pdf` (`presentedForm.contentType`) in the R4 `mimetypes` value set. That value set is all of BCP 13, and `application/pdf` is a registered type. The text attachment's `text/plain; charset=utf-8` validates.
  - A tx.fhir.org cache-session error appeared while checking the LOINC codes. The codes were confirmed separately with `$lookup` on tx.fhir.org: `24590-2` "MR Brain" and `37550-1` "XR Wrist - left PA and Lateral and Oblique".
- **SOP Class warning.** One message was left out of the counts above. The validator warns that it cannot find the value set bound to `ImagingStudy.series.instance.sopClass`, a page in the DICOM standard. This comes from FHIR R4 core: every R4 ImagingStudy with instances gets it, the IG's own examples included.

## SMART App Launch details

- **Supported:**
  - standalone launch, `response_type=code`;
  - public clients (`token_endpoint_auth_methods_supported: ["none"]`);
  - PKCE S256, which is required (`plain` and missing challenges are refused);
  - `state` (required);
  - `aud` (required: the clinical or the imaging base; the token is bound to all three resource bases either way);
  - exact `redirect_uri` match for registered clients;
  - `authorize` by GET or POST;
  - `launch/patient`, `offline_access` and `online_access`;
  - `patient/` scopes in v2 (`.rs`) and v1 (`.read`) syntax;
  - refresh, which keeps the refresh token and can narrow scopes;
  - token responses with `access_token`, `token_type`, `expires_in`, `scope` and `patient` (unlike the IG's example: [smart-imaging#2](https://github.com/argonautproject/smart-imaging/issues/2));
  - RFC 7662 introspection with `active`, `scope`, `client_id`, `exp`, `iat`, `iss`, `aud` and `patient`;
  - RFC 7009 revocation;
  - single-use codes that live 60 s. Replaying a code revokes the grant issued from it.
- **Narrowed:**
  - write permissions are dropped, because the server is read-only (`patient/*.cruds` becomes `patient/*.rs`);
  - scopes for resources it does not serve are dropped;
  - the consent page lists the requested scopes it cannot grant at all; narrowed scopes appear in their narrowed form.
- **Not supported:**
  - EHR launch;
  - `openid` and `fhirUser`;
  - `user/` and `system/` scopes;
  - granular scopes with query parameters;
  - confidential and asymmetric clients;
  - dynamic registration.
- **Additions:**
  - introspection also returns `imaging_study_uids`: the studies the user chose to share. This field is not part of SMART. A separate DICOMweb server would need it, or a policy lookup, to enforce study-level restrictions;
  - `OPEN_CLIENTS` (default on) accepts any unregistered `client_id` with an https or loopback redirect, so other apps can try the sandbox.

## Unclear points in the IG

These came up while building the sandbox. Each says what the sandbox does.

1. **`aud` when the clinical and imaging endpoints differ.** SMART asks for `aud` to be "the base URL of the FHIR server". The same token is then meant for two FHIR servers and a WADO-RS server. The IG does not say which base the app sends as `aud`, or how a separate Imaging Server checks that a token was "issued … for use at this resource server" (check 1 of the required token checks). **Ruling (Josh):** the token format is internal, so bind each token to every resource base. The sandbox records the clinical, imaging and WADO-RS bases with each grant. Each server checks its own base, and introspection returns the list as `aud`. (A JWT could carry the same list as an array `aud`, RFC 7519 §4.1.3.)
2. **The status code when WADO-RS denies a study.** The IG says such a request is "Denied", and it gives 403 for a patient mismatch on search and for an expired capability, but it does not give a code for a study outside the authorization on a plain (non-capability) WADO-RS URL. The choice matters, because a 404 for unknown studies alongside a 403 for unauthorized ones reveals which UIDs exist. **Ruling (Josh):** do not reveal existence. The sandbox returns 403 for both, with an identical body and headers.
3. **An expired token on a capability URL.** "A retrieval request using an expired or revoked URL capability SHALL receive 403". When the token has also expired, as it does whenever the capability outlives it, RFC 6750 suggests 401 `invalid_token`. The sandbox checks the token first and returns 401. The IG's recovery section accepts either code, but the SHALL reads as if 403 always wins.
4. **Which scope permission covers retrieval.** The IG says "patient-level imaging scopes" cover WADO-RS, but not which permission letter. For a token with `patient/ImagingStudy.s` and no `r`, should search succeed and retrieval fail? **Ruling (Josh):** `.rs` covers search plus retrieval, `.r` alone permits retrieval, and search requires `s`. A sentence such as "WADO-RS retrieval requires read (`r`) access to ImagingStudy" would settle it in the IG.
5. **What a capability is bound to.** "The capability SHALL be bound to the SMART token". After a refresh, the new access token represents the same authorization. Binding to the token string means the client must search again after every refresh; binding to the grant would not. **Ruling (Josh):** bind to the grant. The sandbox's capabilities survive a refresh and are refused once the grant is revoked or expires. The IG's recovery steps cope either way, but "token" could mean either.
6. **A read in capability mode.** Response-local `urn:uuid` Endpoints exist only in Bundles. The IG does not say what `GET ImagingStudy/{id}` returns when the server issues capabilities. The sandbox returns the capability Endpoint contained (`#wado`). **Ruling (Josh):** no change needed.
7. **`_lastUpdated` and authorization changes.** Incremental sync uses `_lastUpdated` on ImagingStudy. If a study becomes visible to a token without changing (a consent or proxy change, say), a `gt` query never returns it. The IG might say whether `meta.lastUpdated` reflects only the study, or the study as seen through this authorization. **Ruling (Josh):** no change; what the user sees is what they consented to.
8. **Search without `patient`.** The IG says no population-wide search is required. It does not say what an App Launch request without `patient` gets: 400, 403, or the context patient's studies. The sandbox returns 400.
9. **The transfer syntax when the client omits it.** The IG requires support for `transfer-syntax=*`, so a static store behind a proxy can take part. By PS3.18, a request that omits the parameter means Explicit VR Little Endian, which forces transcoding of compressed studies. The IG could tell apps to always send `transfer-syntax=*`, or tell servers what to do when it is absent. **Ruling (Josh):** refuse with 406 and an explanation, which the sandbox now does. Filed as [smart-imaging#3](https://github.com/argonautproject/smart-imaging/issues/3).
10. **The token response example.** The token response example under App Launch omits `token_type` and `scope`. OAuth 2.0 requires `token_type`; SMART requires `scope`. Copying the example would produce a non-conformant response. The sandbox includes both. Filed as [smart-imaging#2](https://github.com/argonautproject/smart-imaging/issues/2).
11. **Where `launch/patient` is needed.** The IG says the app "receives an access token with patient context". It does not say that a standalone app must request `launch/patient` to get it. The sandbox always assigns the chosen patient.
12. **`payloadMimeType`.** The IG examples leave `Endpoint.payloadMimeType` out. Setting it to `application/dicom` fails R4 validation, because the validator cannot resolve BCP 13 codes in `http://hl7.org/fhir/ValueSet/mimetypes`; the sandbox leaves it out. A note in the profile would spare implementers the error.
13. **No client CapabilityStatement.** Several requirements fall on the App (supporting all three Endpoint forms, the 503 retry, the token handling). The only CapabilityStatement is for the Imaging FHIR server, so these app requirements live only in prose.
14. **DiagnosticReport to ImagingStudy.** The [Imaging Identifiers](https://build.fhir.org/ig/argonautproject/smart-imaging/identifiers.html) page says a DiagnosticReport "should reference the study by Study Instance UID — an identifier reference". The sandbox sends `DiagnosticReport.imagingStudy` with both an absolute `reference` to the imaging server and an `identifier` (`urn:dicom:uid`). An example would show implementers which form apps should rely on.
