import { init, RenderingEngine, Enums, cache, type Types } from "@cornerstonejs/core";
import { init as initLoader, wadors } from "@cornerstonejs/dicom-image-loader";
import { utilities as metadata } from "@cornerstonejs/metadata";
import { init as initTools, addTool, ToolGroupManager, WindowLevelTool, PanTool, ZoomTool, StackScrollTool, Enums as ToolEnums } from "@cornerstonejs/tools";
let initialized: Promise<void> | undefined;
function setup() {
  return initialized ??= (async () => {
    await init();
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
  return {
    async showSeries(series: string) {
      const current = ++generation; ready = false; request?.abort(); request = new AbortController();
      status("Reading series metadata…");
      const url = `${root}studies/${study}/series/${series}`, response = await fetch(`${url}/metadata`, { signal: request.signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Metadata could not be loaded");
      if (current !== generation || disposed) return;
      const value = (json: any, tag: string) => json[tag]?.Value?.[0];
      data.sort((a: any, b: any) => Number(value(a, "00200013") ?? 0) - Number(value(b, "00200013") ?? 0));
      const imageIds: string[] = [];
      for (const json of data) {
        if (!value(json, "00280010") || !json["7FE00010"]) continue;
        const base = `wadors:${url}/instances/${value(json, "00080018")}/frames/`;
        wadors.metaDataManager.add(base + "1", json);
        for (let k = 1; k <= Number(value(json, "00280008") ?? 1); k++) {
          const imageId = base + k; metadata.addDicomWebInstance(imageId, json); imageIds.push(imageId);
        }
      }
      if (!imageIds.length) throw new Error("This series has no supported image frames. Choose a CT or MR series.");
      status(`Loading image 1 of ${imageIds.length}…`);
      await viewport.setStack(imageIds); if (current !== generation || disposed) return;
      ready = true; engine.resize(true, false); viewport.render(); el.dataset.loaded = "true";
      status(`${imageIds.length} images · Scroll: slices · Drag: window/level · Middle drag: pan · Right drag: zoom`);
    },
    dispose() { disposed = true; generation++; request?.abort(); resize.disconnect(); ToolGroupManager.destroyToolGroup(id); engine.destroy(); cache.purgeCache(); el.remove(); },
  };
}
