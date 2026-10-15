// Slide controls: the focus control (when the slide has several focal planes) and a Layers sheet
// (fluorescence channels with colour and intensity, the scanner's colour profile, annotations and
// segmentations). Built here, not in index.html, so the slide view owns all of its UI.
import { formatBytes } from "../core/format";
import type { SlideView } from "./wsi-view";

const CSS = `
.wsi-focus { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.wsi-focus input[type=range] { flex: 1; min-width: 0; accent-color: var(--accent); height: 32px; }
.wsi-focus .wsi-focus-label { font-size: 0.8125rem; color: var(--text-2); white-space: nowrap; }
@media (pointer: coarse) { .wsi-focus input[type=range] { height: 44px; } }
.wsi-layers h3 { font-size: 0.8125rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-3); margin: 14px 0 4px; }
.wsi-row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 2px 0; border-bottom: 1px solid var(--border); }
.wsi-row:last-child { border-bottom: 0; }
.wsi-row label.wsi-name { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; cursor: pointer; }
.wsi-row label.wsi-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsi-row input[type=checkbox] { width: 22px; height: 22px; flex: none; accent-color: var(--accent); }
.wsi-row input[type=color] { width: 44px; height: 32px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: none; flex: none; }
.wsi-row input[type=range] { width: 34%; min-width: 90px; accent-color: var(--accent); }
.wsi-sub { font-size: 0.8125rem; color: var(--text-3); margin: 0 0 6px 32px; }
.wsi-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.wsi-layers .wsi-note { font-size: 0.8125rem; color: var(--text-3); margin: 2px 0 6px; }
.wsi-progress {
  position: absolute; z-index: 3; left: 50%; top: 56px; transform: translateX(-50%);
  width: min(360px, calc(100% - 32px)); padding: 8px 12px 10px; border-radius: 8px;
  background: rgba(10, 10, 10, 0.82); color: #f4f4f4; font-size: 0.875rem; line-height: 1.35; pointer-events: none;
}
.wsi-progress-track { height: 4px; margin-top: 6px; border-radius: 2px; background: rgba(255, 255, 255, 0.2); overflow: hidden; }
.wsi-progress-bar { height: 100%; width: 0; background: #4fb3ff; transition: width 0.25s; }
.wsi-info {
  position: absolute; z-index: 2; left: calc(10px + var(--safe-l)); top: 48px; max-width: min(55%, 420px); margin: 0;
  padding: 4px 8px; border-radius: 6px; background: rgba(10, 10, 10, 0.7); color: #e6e6e6; font-size: 0.75rem; line-height: 1.35; pointer-events: none;
}
/* Slide-only controls never show outside slide mode. */
body:not(.slide-mode) #btn-label, body:not(.slide-mode) #btn-wsi-layers, body:not(.slide-mode) .wsi-focus { display: none !important; }
@media (max-width: 600px) { .wsi-progress { top: auto; bottom: 150px; } .wsi-info { max-width: 60%; } }
`;

let styled = false;

export class SlidePanel {
  private focus: HTMLDivElement;
  private focusInput: HTMLInputElement;
  private focusLabel: HTMLSpanElement;
  private button: HTMLButtonElement;
  private sheet: HTMLElement;
  private body: HTMLDivElement;
  private open = false;

  constructor(private view: SlideView) {
    if (!styled) {
      const s = document.createElement("style");
      s.textContent = CSS;
      document.head.append(s);
      styled = true;
    }
    this.focus = document.createElement("div");
    this.focus.className = "wsi-focus hidden";
    const lab = document.createElement("label");
    lab.className = "wsi-focus-label";
    lab.textContent = "Focus";
    lab.htmlFor = "wsi-focus";
    this.focusInput = document.createElement("input");
    this.focusInput.type = "range";
    this.focusInput.id = "wsi-focus";
    this.focusInput.step = "1";
    this.focusInput.addEventListener("input", () => this.view.setPlane(Number(this.focusInput.value)));
    this.focusLabel = document.createElement("span");
    this.focusLabel.className = "wsi-focus-label mono";
    this.focus.append(lab, this.focusInput, this.focusLabel);

    this.button = document.createElement("button");
    this.button.className = "btn hidden";
    this.button.type = "button";
    this.button.id = "btn-wsi-layers";
    this.button.textContent = "Layers";
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.addEventListener("click", () => this.show());

    this.sheet = document.createElement("section");
    this.sheet.className = "sheet wsi-layers hidden";
    this.sheet.id = "sheet-wsi-layers";
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-modal", "true");
    this.sheet.setAttribute("aria-labelledby", "wsi-layers-title");
    const grip = document.createElement("div");
    grip.className = "sheet-grip";
    const h2 = document.createElement("h2");
    h2.id = "wsi-layers-title";
    h2.textContent = "Layers";
    this.body = document.createElement("div");
    const close = document.createElement("button");
    close.className = "btn btn-ghost sheet-close";
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => this.hide());
    this.sheet.append(grip, h2, this.body, close);
    document.body.append(this.sheet);
    document.getElementById("sheet-backdrop")?.addEventListener("click", () => this.hide());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hide();
    });
  }

  /** Puts the controls into the toolbar (slide shown). */
  attach() {
    const toolbar = document.getElementById("toolbar");
    const btns = toolbar?.querySelector(".tool-btns");
    if (toolbar && !this.focus.isConnected) toolbar.prepend(this.focus);
    if (btns && !this.button.isConnected) btns.prepend(this.button);
    this.refresh();
  }

  /** Takes them out again (slide closed). */
  detach() {
    this.hide();
    this.focus.remove();
    this.button.remove();
  }

  show() {
    this.open = true;
    this.render();
    document.getElementById("sheet-backdrop")?.classList.remove("hidden");
    this.sheet.classList.remove("hidden");
    this.sheet.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.sheet.classList.add("hidden");
    document.getElementById("sheet-backdrop")?.classList.add("hidden");
  }

  /** Updates the toolbar controls (and the sheet, when open). */
  refresh() {
    const ss = this.view.ss;
    if (!ss) return;
    const p = ss.pyramid;
    const planes = p.planes.length;
    this.focus.classList.toggle("hidden", planes < 2);
    if (planes > 1) {
      const z = this.view.display.plane;
      this.focusInput.min = "0";
      this.focusInput.max = String(planes - 1);
      this.focusInput.value = String(z);
      const rel = p.planesInMicrons ? ` · ${p.planes[z] - p.planes[Math.floor((planes - 1) / 2)] >= 0 ? "+" : ""}${(p.planes[z] - p.planes[Math.floor((planes - 1) / 2)]).toFixed(1)} µm` : "";
      this.focusLabel.textContent = `${z + 1} of ${planes}${rel}`;
    }
    const channels = p.monochrome && p.paths.length > 1;
    const any = channels || !!ss.icc || this.view.layers.length > 0;
    this.button.classList.toggle("hidden", !any);
    this.button.textContent = channels && !this.view.layers.length ? "Channels" : "Layers";
    if (this.open) this.render();
  }

  private row(...children: (Node | string)[]) {
    const r = document.createElement("div");
    r.className = "wsi-row";
    r.append(...children);
    return r;
  }

  private check(text: string, checked: boolean, on: (v: boolean) => void, swatch?: [number, number, number]) {
    const lab = document.createElement("label");
    lab.className = "wsi-name";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", () => on(box.checked));
    const t = document.createElement("span");
    if (swatch) {
      const s = document.createElement("i");
      s.className = "wsi-swatch";
      s.style.background = `rgb(${swatch.join(",")})`;
      t.append(s);
    }
    t.append(text);
    lab.append(box, t);
    return lab;
  }

  private heading(text: string) {
    const h = document.createElement("h3");
    h.textContent = text;
    return h;
  }

  private note(text: string, cls = "wsi-note") {
    const p = document.createElement("p");
    p.className = cls;
    p.textContent = text;
    return p;
  }

  private render() {
    const v = this.view;
    const ss = v.ss;
    this.body.textContent = "";
    if (!ss) return;
    const p = ss.pyramid;
    if (p.monochrome && p.paths.length > 1) {
      this.body.append(this.heading("Channels"));
      p.paths.forEach((path, k) => {
        const ch = v.display.channels[k];
        const color = document.createElement("input");
        color.type = "color";
        color.value = "#" + ch.color.map((c) => c.toString(16).padStart(2, "0")).join("");
        color.setAttribute("aria-label", `${path.label} colour`);
        color.addEventListener("input", () => {
          const hex = color.value.slice(1);
          v.setChannel(k, { color: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number] });
        });
        const gain = document.createElement("input");
        gain.type = "range";
        gain.min = "0";
        gain.max = "400";
        gain.step = "5";
        gain.value = String(Math.round(ch.gain * 100));
        gain.setAttribute("aria-label", `${path.label} intensity`);
        gain.addEventListener("input", () => v.setChannel(k, { gain: Number(gain.value) / 100 }));
        const r = this.row(this.check(path.label, ch.visible, (on) => v.setChannel(k, { visible: on })), color, gain);
        r.dataset.channel = String(k);
        this.body.append(r);
      });
      this.body.append(this.note("Each visible channel is fetched and drawn. Intensity scales the channel's brightness."));
    }
    if (ss.icc) {
      this.body.append(this.heading("Colour"));
      this.body.append(this.row(this.check(`Use the scanner's colour profile (${ss.icc.description || "ICC"})`, ss.iccOn, (on) => v.setIcc(on))));
    }
    const ann = v.layers.filter((l) => l.kind === "annotations");
    const seg = v.layers.filter((l) => l.kind === "segmentation");
    for (const [title, list] of [["Annotations", ann], ["Segmentations", seg]] as const) {
      if (!list.length) continue;
      this.body.append(this.heading(title));
      for (const l of list) {
        const r = this.row(this.check(l.title, l.visible, (on) => void v.setLayer(l.id, on)));
        r.dataset.layer = l.id;
        this.body.append(r);
        const state =
          l.state === "loading" ? `Reading ${formatBytes(l.bytes)}…`
          : l.state === "failed" ? `Could not be shown: ${l.error}`
          : l.state === "ready" ? l.detail
          : `${formatBytes(l.bytes)}, read when shown`;
        this.body.append(this.note(state, "wsi-sub"));
        if (l.kind === "annotations" && l.data && l.data.groups.length > 1) {
          l.data.groups.forEach((g, gi) => {
            const gr = this.row(this.check(`${g.label} (${g.count.toLocaleString()})`, l.groupVisible[gi], (on) => ((l.groupVisible[gi] = on), v.requestDraw()), l.colors[gi]));
            gr.style.paddingLeft = "32px";
            this.body.append(gr);
          });
        }
        if (l.kind === "segmentation" && l.ss) {
          l.ss.pyramid.paths.forEach((path, k) => {
            const gr = this.row(this.check(path.label, l.segmentVisible[k], (on) => ((l.segmentVisible[k] = on), v.requestUpdate()), l.ss!.segmentColors[k]));
            gr.style.paddingLeft = "32px";
            this.body.append(gr);
          });
        }
      }
    }
  }
}
