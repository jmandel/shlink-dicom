import { openShare } from "../core/share";
import { DicomwebSession } from "./session";
import { PROTOCOL, servePort } from "./transport";
let current: DicomwebSession | undefined, session: string | undefined;
self.onmessage = async ({ data, ports }) => {
  if (data.type === "open") {
    try {
      current?.close();
      const share = await openShare(data.link, { passcode: data.passcode, recipient: "SHLink DICOMweb viewer" });
      current = new DicomwebSession(share, data.root); session = data.session;
      self.postMessage({ type: "opened", studies: share.index.studies.map(st => ({ uid: st.studyInstanceUid, description: st.description, modalities: st.modalities, series: st.series.map(se => ({ uid: se.uid, description: se.description, modality: se.modality, instances: se.instances.length })) })) });
    } catch (e) { self.postMessage({ type: "error", message: (e as Error).message }); }
  } else if (data.protocol === PROTOCOL && ports[0]) {
    await servePort(ports[0], data, r => current && session === data.session ? current.handle(r) : Promise.resolve(new Response("This session has closed", { status: 410 })));
  } else if (data.type === "stats") self.postMessage({ type: "stats", stats: current?.stats });
  else if (data.type === "close") { current?.close(); current = undefined; }
};
