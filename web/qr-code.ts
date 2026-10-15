import qrcode from "qrcode-generator";

/**
 * Generates an inline SVG string for a SMART Health Link QR code
 * using Error Correction Level M (as recommended by the SHL specification).
 */
export function renderQrSvg(text: string, cellSize = 3, margin = 2): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}

export function showQrModal(label: string, shlinkUri: string) {
  let modal = document.getElementById("qr-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "qr-modal";
    modal.className = "qr-modal-backdrop";
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal!.classList.add("hidden");
    });
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="qr-modal-card" role="dialog" aria-label="SMART Health Link QR Code">
      <div class="row-between">
        <strong>${escapeHtml(label)}</strong>
        <button class="intro-dismiss" id="btn-close-qr" aria-label="Close QR modal">✕</button>
      </div>
      <div class="qr-modal-svg">${renderQrSvg(shlinkUri, 5, 3)}</div>
      <div class="qr-modal-caption">SMART Health Link · Error Correction Level M</div>
    </div>
  `;
  modal.classList.remove("hidden");
  modal.querySelector("#btn-close-qr")?.addEventListener("click", () => {
    modal!.classList.add("hidden");
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
