import { init, RenderingEngine, Enums, cache, imageLoader, type Types } from "@cornerstonejs/core";
import { init as initLoader, wadors } from "@cornerstonejs/dicom-image-loader";
import { utilities as metadata } from "@cornerstonejs/metadata";
import { init as initTools, addTool, ToolGroupManager, WindowLevelTool, PanTool, ZoomTool, StackScrollTool, Enums as ToolEnums } from "@cornerstonejs/tools";
let initialized: Promise<void> | undefined;
function setup() {
  return initialized ??= (async () => {
    await init();
    cache.setMaxCacheSize(128 * 1024 * 1024);
    initLoader({ maxWebWorkers: 2, wasmBasePath: new URL("./", import.meta.url).href });
    await initTools();
    for (const Tool of [WindowLevelTool, PanTool, ZoomTool, StackScrollTool]) addTool(Tool);
  })();
}
export async function mountCornerstone(host: HTMLElement, root: string, study: string, status: (s: string, error?: boolean) => void) {
  await setup();
  const el = document.createElement("div"); el.className = "cornerstone-viewport"; host.append(el);
  el.oncontextmenu = e => e.preventDefault();
  const id = crypto.randomUUID(), viewportId = "stack", engine = new RenderingEngine(id);
  engine.enableElement({ viewportId, type: Enums.ViewportType.STACK, element: el, defaultOptions: { background: [0, 0, 0] } });
  const viewport = engine.getViewport<Types.IStackViewport>(viewportId), group = ToolGroupManager.createToolGroup(id)!;
  for (const Tool of [WindowLevelTool, PanTool, ZoomTool, StackScrollTool]) group.addTool(Tool.toolName);
  group.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] });
  group.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Auxiliary }] });
  group.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }] });
  group.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }] });
  group.addViewport(viewportId, id);
  let ready = false;
  const resize = new ResizeObserver(() => { if (ready) engine.resize(true, false); }); resize.observe(el);
  let generation = 0, disposed = false, request: AbortController | undefined;
  let imageIds: string[] = [], queue: string[] = [], lastIndex = 0;
  const pending = new Set<string>();
  // Two low-priority decodes warm a small neighborhood without downloading a
  // whole series. Replacing the queue on scroll/switch drops obsolete work.
  function pump() {
    while (!disposed && pending.size < 2 && queue.length) {
      const imageId = queue.shift()!;
      if (pending.has(imageId) || cache.getImageLoadObject(imageId)) continue;
      pending.add(imageId);
      void imageLoader.loadAndCacheImage(imageId, { requestType: Enums.RequestType.Prefetch }).catch(() => {
        // A foreground request reports any error if this slice is selected.
      }).finally(() => { pending.delete(imageId); pump(); });
    }
  }
  function warm() {
    if (!ready || disposed) return;
    const index = viewport.getCurrentImageIdIndex(), direction = index < lastIndex ? -1 : 1;
    lastIndex = index;
    const size = cache.getImage(imageIds[index])?.sizeInBytes ?? Infinity;
    const count = Math.min(10, Math.floor(32 * 1024 * 1024 / size));
    const nearby = [...Array.from({ length: 8 }, (_, i) => index + direction * (i + 1)), index - direction, index - direction * 2];
    queue = nearby.filter(i => i >= 0 && i < imageIds.length).slice(0, count).map(i => imageIds[i]);
    pump();
  }
  function updateImage() {
    if (!ready || disposed) return;
    el.dataset.imageId = viewport.getCurrentImageId();
    status(`Image ${viewport.getCurrentImageIdIndex() + 1} of ${imageIds.length} · Scroll: slices · Drag: window/level · Middle drag: pan · Right drag: zoom`);
    warm();
  }
  el.addEventListener(Enums.Events.STACK_NEW_IMAGE, updateImage);
  return {
    async showSeries(series: string) {
      const current = ++generation; ready = false; queue = []; request?.abort(); request = new AbortController();
      el.dataset.loaded = "false"; delete el.dataset.error; delete el.dataset.imageId;
      try {
        status("Reading series metadata…");
        const url = `${root}studies/${study}/series/${series}`, response = await fetch(`${url}/metadata`, { signal: request.signal });
        const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Metadata could not be loaded");
        if (current !== generation || disposed) return;
        const value = (json: any, tag: string) => json[tag]?.Value?.[0];
        data.sort((a: any, b: any) => Number(value(a, "00200013") ?? 0) - Number(value(b, "00200013") ?? 0));
        imageIds = []; lastIndex = 0;
        for (const json of data) {
          if (value(json, "00080060") === "SM") throw new Error("Whole-slide microscopy needs the main SHLink DICOM viewer. Choose another series here.");
          if (!value(json, "00280010") || !json["7FE00010"]) continue;
          const base = `wadors:${url}/instances/${value(json, "00080018")}/frames/`;
          wadors.metaDataManager.add(base + "1", json);
          for (let k = 1; k <= Number(value(json, "00280008") ?? 1); k++) {
            const imageId = base + k; metadata.addDicomWebInstance(imageId, json); imageIds.push(imageId);
          }
        }
        if (!imageIds.length) throw new Error("This series contains no displayable image frames. Choose an image series, or open it in the main SHLink DICOM viewer.");
        status(`Loading image 1 of ${imageIds.length}…`);
        await viewport.setStack(imageIds); if (current !== generation || disposed) return;
        ready = true; engine.resize(true, false); viewport.render(); el.dataset.loaded = "true";
        updateImage();
      } catch (e) {
        if (current !== generation || disposed) return;
        el.dataset.error = "true"; throw e;
      }
    },
    dispose() { disposed = true; generation++; queue = []; request?.abort(); el.removeEventListener(Enums.Events.STACK_NEW_IMAGE, updateImage); resize.disconnect(); ToolGroupManager.destroyToolGroup(id); engine.destroy(); cache.purgeCache(); el.remove(); },
  };
}
