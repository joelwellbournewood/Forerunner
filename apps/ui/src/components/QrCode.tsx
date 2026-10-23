import { encode } from "uqr";

/**
 * A QR code drawn as one SVG path (spec R.2: the phone scans the pairing link from the
 * desktop). `uqr` encodes; the modules are drawn here so no markup string is injected. Dark
 * modules on a white quiet zone in both themes, since scanners need the contrast.
 */
export function qrModules(text: string): boolean[][] {
  // ECC M survives a glare or a smudge on the screen; a border of 4 modules is the quiet zone.
  return encode(text, { ecc: "M", border: 4 }).data;
}

export function qrPath(modules: boolean[][]): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let run = 1;
      while (row[x + run]) run++;
      parts.push(`M${x} ${y}h${run}v1h-${run}z`);
      x += run;
    }
  });
  return parts.join("");
}

export function QrCode({
  text,
  label,
  size = 224,
  testId = "qr-code",
}: {
  text: string;
  /** Accessible name, e.g. "QR code of the pairing link". */
  label: string;
  size?: number;
  testId?: string;
}) {
  const modules = qrModules(text);
  const n = modules.length;
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid={testId}
      data-modules={n}
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      className="rounded bg-white"
    >
      <rect width={n} height={n} fill="#ffffff" />
      <path d={qrPath(modules)} fill="#000000" />
    </svg>
  );
}
