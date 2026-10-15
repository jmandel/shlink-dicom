// Server-rendered HTML for the demo login and consent pages. No scripts.

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const css = `
:root { --bg:#f6f7f9; --card:#fff; --ink:#1b1f24; --muted:#5b6470; --line:#d9dde3; --accent:#1f5fbf; --accent-ink:#fff; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171b; --card:#1d2126; --ink:#e8eaed; --muted:#9aa3ad; --line:#333a42; --accent:#6ea2f0; --accent-ink:#0d1117; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
header { padding:14px 16px; border-bottom:1px solid var(--line); font-size:14px; color:var(--muted); }
main { max-width:520px; margin:24px auto; padding:0 16px; }
h1 { font-size:22px; margin:0 0 8px; }
.lede { margin:0 0 18px; }
fieldset { border:1px solid var(--line); border-radius:10px; background:var(--card); padding:6px 12px 10px; margin:0 0 16px; }
legend { font-weight:600; padding:0 6px; }
.choice { display:flex; gap:12px; align-items:flex-start; padding:10px 2px; border-top:1px solid var(--line); cursor:pointer; }
.choice:first-of-type { border-top:0; }
.choice input { flex:none; margin-top:4px; width:18px; height:18px; }
.choice span { display:flex; flex-direction:column; }
small { color:var(--muted); font-size:13px; }
code { font-size:12px; }
.note { color:var(--muted); font-size:14px; }
.actions { display:flex; gap:12px; justify-content:flex-end; margin:8px 0 32px; }
button { font:inherit; padding:10px 18px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; min-width:96px; }
button.primary { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
form > button.primary { width:100%; }
`;

export function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Imaging sandbox</title><style>${css}</style></head>
<body><header>Imaging sandbox · demo patient portal</header><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}
