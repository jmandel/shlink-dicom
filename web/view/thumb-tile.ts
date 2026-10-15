// A thumbnail tile (study cards and the series strip): a neutral placeholder until the image is
// drawn; while its file arrives, a bar and "4.2 of 10 MB" driven by the bytes received against
// the file's length; a short status where there is no byte count (opening a slide); and a plain
// error when the image cannot be shown. Never black and empty.
import { formatBytes } from "../core/index";

export class ThumbTile {
  readonly el: HTMLSpanElement;
  private over: HTMLSpanElement;
  private bar: HTMLSpanElement | null = null;
  private fill: HTMLSpanElement | null = null;
  private label: HTMLSpanElement;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.el = document.createElement("span");
    this.el.className = "thumb-tile";
    canvas.replaceWith(this.el);
    this.over = document.createElement("span");
    this.over.className = "thumb-over hidden";
    this.label = document.createElement("span");
    this.label.className = "thumb-label";
    this.over.append(this.label);
    this.el.append(canvas, this.over);
  }

  /** Bytes received of the file the thumbnail is made from. */
  progress(received: number, total: number) {
    if (this.canvas.dataset.drawn) return;
    if (!this.bar) {
      this.bar = document.createElement("span");
      this.bar.className = "thumb-bar";
      this.bar.setAttribute("role", "progressbar");
      this.bar.setAttribute("aria-valuemin", "0");
      this.bar.setAttribute("aria-label", "Loading the image");
      this.fill = document.createElement("span");
      this.fill.className = "thumb-fill";
      this.bar.append(this.fill);
      this.over.prepend(this.bar);
    }
    const r = Math.min(received, total);
    this.bar.setAttribute("aria-valuemax", String(total));
    this.bar.setAttribute("aria-valuenow", String(r));
    this.fill!.style.width = `${total ? (100 * r) / total : 0}%`;
    const text = `${formatBytes(r)} of ${formatBytes(total)}`;
    this.bar.setAttribute("aria-valuetext", text);
    this.label.textContent = text;
    this.over.classList.remove("hidden", "thumb-error");
  }

  /** A status where no byte count applies. */
  status(text: string) {
    if (this.canvas.dataset.drawn) return;
    this.label.textContent = text;
    this.over.classList.remove("hidden");
  }

  /** A first picture (the file's own icon) while the real image still arrives: the bar stays. */
  preview() {
    this.canvas.dataset.preview = "1";
    this.el.classList.add("has-image");
  }

  drawn() {
    this.canvas.dataset.drawn = "1";
    delete this.canvas.dataset.preview;
    this.el.classList.add("has-image");
    this.over.classList.add("hidden");
  }

  failed(text: string) {
    this.canvas.dataset.error = text;
    this.bar?.remove();
    this.bar = this.fill = null;
    this.label.textContent = text;
    this.over.classList.add("thumb-error");
    this.over.classList.remove("hidden");
  }
}
