export interface DownloadableFile {
  filename: string;
  contentType: string;
  text: string;
}

/** Browsers may still be reading the object URL when the click returns; revoke a moment later. */
const REVOKE_DELAY_MS = 1_000;

type ObjectUrls = {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

/**
 * Hand a text file to the browser as a download: a Blob behind an object URL on a hidden
 * anchor with the `download` name, clicked once and removed. Returns false where object URLs
 * do not exist (nothing is saved, nothing thrown), so a page can say so.
 */
export function saveTextFile(file: DownloadableFile, doc: Document = document): boolean {
  const urls = (globalThis as { URL?: ObjectUrls }).URL;
  if (typeof urls?.createObjectURL !== "function") return false;
  const href = urls.createObjectURL(new Blob([file.text], { type: file.contentType }));
  const anchor = doc.createElement("a");
  anchor.href = href;
  anchor.download = file.filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  doc.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => urls.revokeObjectURL?.(href), REVOKE_DELAY_MS);
  }
  return true;
}
