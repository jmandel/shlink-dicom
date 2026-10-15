export interface CornerstoneImageObject {
  imageId: string;
  minPixelValue: number;
  maxPixelValue: number;
  slope: number;
  intercept: number;
  windowCenter: number;
  windowWidth: number;
  getPixelData: () => Uint8Array;
  getCanvas?: () => HTMLCanvasElement;
  rows: number;
  columns: number;
  height: number;
  width: number;
  color: boolean;
  sizeInBytes: number;
  dicomBytes: Uint8Array;
}

export type ShlSliceLoaderFn = (
  studyIdx: number,
  seriesIdx: number,
  instanceIdx: number,
) => Promise<{
  width: number;
  height: number;
  rgba: Uint8Array;
  windowCenter: number;
  windowWidth: number;
  minPixel: number;
  maxPixel: number;
  dicomBytes: Uint8Array;
}>;

export function formatCornerstoneImageId(
  studyIdx: number,
  seriesIdx: number,
  instanceIdx: number,
): string {
  return `shl-dicom://study/${studyIdx}/series/${seriesIdx}/instance/${instanceIdx}`;
}

export function parseCornerstoneImageId(imageId: string): {
  studyIdx: number;
  seriesIdx: number;
  instanceIdx: number;
} {
  const m = /^shl-dicom:\/\/study\/(\d+)\/series\/(\d+)\/instance\/(\d+)$/.exec(imageId);
  if (!m) throw new Error(`Invalid shl-dicom Cornerstone imageId: ${imageId}`);
  return {
    studyIdx: Number(m[1]),
    seriesIdx: Number(m[2]),
    instanceIdx: Number(m[3]),
  };
}

export function createShlCornerstoneImageLoader(loaderFn: ShlSliceLoaderFn) {
  return function loadImage(imageId: string): { promise: Promise<CornerstoneImageObject> } {
    const { studyIdx, seriesIdx, instanceIdx } = parseCornerstoneImageId(imageId);
    const promise = loaderFn(studyIdx, seriesIdx, instanceIdx).then((res) => ({
      imageId,
      minPixelValue: res.minPixel,
      maxPixelValue: res.maxPixel,
      slope: 1,
      intercept: 0,
      windowCenter: res.windowCenter,
      windowWidth: res.windowWidth,
      getPixelData: () => res.rgba,
      rows: res.height,
      columns: res.width,
      height: res.height,
      width: res.width,
      color: true,
      sizeInBytes: res.rgba.byteLength,
      dicomBytes: res.dicomBytes,
    }));
    return { promise };
  };
}

export function registerShlCornerstoneLoader(
  cornerstoneObj: { registerImageLoader?: (scheme: string, loader: unknown) => void },
  loaderFn: ShlSliceLoaderFn,
) {
  const loader = createShlCornerstoneImageLoader(loaderFn);
  if (typeof cornerstoneObj?.registerImageLoader === "function") {
    cornerstoneObj.registerImageLoader("shl-dicom", loader);
  }
  return loader;
}
