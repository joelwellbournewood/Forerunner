/**
 * Files and data (spec L.1, A.3, K.2 "Data" tab): registration by path or URI, metadata and
 * capped samples for agents, ZIP and folder import, the Data tab routes and the four tools.
 * See docs/maintainers/data.md.
 */
export * from "./assets.ts";
export * from "./import.ts";
export {
  countLines,
  csvColumns,
  decodeText,
  describeFile,
  describeFolder,
  detectEncoding,
  detectFormat,
  formatFromExtension,
  gifDimensions,
  inferJsonType,
  inferScalarType,
  jpegDimensions,
  mergeTypes,
  mimeFor,
  objectColumns,
  parseCsv,
  parseUri,
  pngDimensions,
  readHead,
  sampleFile,
  sniffDelimiter,
  sniffFormat,
  type TextEncodingName,
} from "./metadata.ts";
export * from "./routes.ts";
export * from "./tools.ts";
export * from "./types.ts";
export * from "./walk.ts";
