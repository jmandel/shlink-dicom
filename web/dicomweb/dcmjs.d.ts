// dcmjs 0.45.0 has no declaration file. The adapter uses only this public reader API.
declare module "dcmjs" {
  const dcmjs: { data: { DicomMessage: {
    readFile(buffer: ArrayBuffer, options?: { untilTag?: string; includeUntilTagValue?: boolean }): { dict: Record<string, any> };
  } } };
  export default dcmjs;
}
