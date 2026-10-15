// Step 6: what the server sees: every request this page has sent it, as log lines.
import { code, h, onRequest, para, reqRow, S } from "./state";

export function mountHost(pic: HTMLElement, exact: HTMLElement) {
  const log = h("div", { class: "host-log", "aria-label": "Requests as the server receives them" });
  const add = (r: any) => {
    log.prepend(reqRow(r, true));
    while (log.children.length > 80) log.lastElementChild!.remove();
  };
  for (const r of S.requests) add(r);
  onRequest(add);
  pic.replaceChildren(h("p", { class: "cap", text: "Requests this page has sent the server, newest first. More appear as you go." }), log);
  exact.replaceChildren(
    para("Each line is one HTTP request: the method, the path, the status the server answered, the ", code("Range"), " header, the bytes sent, and the ", code("recipient"), " name the browser reports. The server records the same fields in its access log. Step 10 shows that log, as stored, for a link you make."),
    para("The paths name the link and the encrypted file by random ids. No name, date or DICOM UID appears, and the key is never sent. What can leak: the files' sizes, and which byte ranges a viewer reads, which hint at where images begin and end."),
  );
}
