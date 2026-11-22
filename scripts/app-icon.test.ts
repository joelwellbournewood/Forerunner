import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { dirname, join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";

// The owner's to-do of 2026-11-18 (docs/status/handoff/NEXT-SESSION.md): the apps shipped
// Tauri's stock icon (yellow and blue rings). The owner confirmed the new design that day:
// docs/design/icon/forerunner-icon.svg, a mahogany cut-stone kite on a crisp rounded square,
// cream at the centre fading radially to tan at the edges, transparent outside the rounded
// corners. These tests read what a person sees: the files each app's tauri.conf.json lists
// (the PNGs and the frames inside icon.ico and icon.icns: the taskbar, the Start menu, the tray,
// the window, the installer), the rest of each icons folder (the Windows tiles and the store
// logo), the Android launcher icons, and the browser tab of the UI (its favicon link).
// How the icon sets are made from the master: docs/maintainers/apps.md, "The app icon".

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const master = join(repoRoot, "docs", "design", "icon", "forerunner-icon.svg");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The master as the owner confirmed it on 2026-11-18. */
const MASTER_SHA256 = "346652eda97962834814a42af1c7e49aaa9d5b8cb8ea7fe7ed222ab04c79ce6e";

/**
 * Tauri's stock icon files as they shipped up to 1.0.4 (base 822f142): the 16 files of each
 * icons folder (both apps had the same bytes) and the Android launcher icons.
 */
const STOCK_SHA256 = new Set([
  "eeebf55d8ffe07348786b9057af253e3ca08c56b6a8f8893826381430e3c0b7b", // 128x128.png
  "2998b41d0c9278b08e8b3874e094920034fe983a46053c9d62764225f58ab7b0", // 128x128@2x.png
  "aaa96d0c53b756b77c7f46aeb72290f42256c786c69be68f6bcdeb9c7492a48e", // 32x32.png
  "33446a858d982a529554e562114673f8b15620588137cf0bf6c56a7441c78cd7", // Square107x107Logo.png
  "633d6dba504faa844b309e01272386e4523cddd4a3639c77c0eb5d2ce3eac752", // Square142x142Logo.png
  "d90061ad71e6f5882b759d80cf58cc16aa5021fa29ba4b2614adea982a4d7ee5", // Square150x150Logo.png
  "5feaa4f18f404843551756dd2791d7654ef471b6b007767ae40f60c7aebcad5b", // Square284x284Logo.png
  "68bc1b585f5685e0922f14b1ca7eb2d618213c684c89e759c6a5eb8578c3fe8d", // Square30x30Logo.png
  "5df8d779ab57c63ee06ed237b94c3c0954711e88117dccfa72b2aec5d83b0d80", // Square310x310Logo.png
  "c46208286b1ea1b4841b714972f3cb0a8abc6d3bfa71a29238f7b4d62f511f89", // Square44x44Logo.png
  "cb0ea93cbd13509d32c6bc06da71687e73d673d166fde91b23061771abe16b86", // Square71x71Logo.png
  "2208da1d741a20e902a59d7c39a5e58af74ec823db13113bf8ac6f555fa25bca", // Square89x89Logo.png
  "9f84d0ce09df51bac0a4855042b3e49b190cc2b9761cd5eab61ebec5cd343820", // StoreLogo.png
  "1535d355994f8ee82da91384d2a29e04d5b4440f3e6051b5c8b06e7a62283693", // icon.icns
  "e38ca88e1d5490f3dcbc3c3fa525f7fcb7b80fff3cb2f3a4eb1b2d018c0915c1", // icon.ico
  "6413bfe9d546e5225fc9256a0ecec48df3a1272ea4bdc91c15b8e000222a95d3", // icon.png
  "75322a261ba38a23a25647af0d1298f204f3b3fafd317b8122a1b9a1f38284ff", // mipmap-mdpi ic_launcher(_round)
  "2425d59d27578f75ca97d31d9ae8385898badce3d6a1774bfc2f0fd191dc12c7", // mipmap-mdpi foreground
  "320e552422179b81dae014ee6cc00561bd6e7455767b28f5518b8862a8c7987c", // mipmap-hdpi ic_launcher(_round)
  "7a9ae0632bfe5b28a1e6e9a7b38982fef62be07c95de46c26bd4f901ac6b9753", // mipmap-hdpi foreground
  "44e5c3dc1dfb392f65e3dbcc9b986d30f10dd95b57e306657e56281b572fa684", // mipmap-xhdpi ic_launcher(_round)
  "b1d19b8b78d0ed6903dd35b7640afba29b4cf02f3780e0d1cd46d9ebcbc93695", // mipmap-xhdpi foreground
  "0b250fc4451dfd1e5a41128234d93225726a2984448b0b966af25677b167d8de", // mipmap-xxhdpi ic_launcher(_round)
  "ab9397c9827aef4b3a1f1f917fc722d54abcf26488880c8bf9c724d1e59ab905", // mipmap-xxhdpi foreground
  "dae1ff05b101efea50e4b622fe6a3af8ba8f761162fa7c4fd864adc7cb39eeac", // mipmap-xxxhdpi ic_launcher(_round)
  "27cf0cdbc78bec8b9a14eaedb084c541a3c191fe5db89766e831fbfd21ce955d", // mipmap-xxxhdpi foreground
]);

/** Each app's icons folder holds these files and nothing else (what `tauri icon` writes, less what the apps never used). */
const ICON_FILES = [
  "128x128.png",
  "128x128@2x.png",
  "32x32.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square30x30Logo.png",
  "Square310x310Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "StoreLogo.png",
  "icon.icns",
  "icon.ico",
  "icon.png",
];

const APPS = [
  { name: "desktop", tauri: join(repoRoot, "apps", "desktop", "src-tauri") },
  { name: "mobile", tauri: join(repoRoot, "apps", "mobile", "src-tauri") },
];
const androidRes = join(
  repoRoot,
  ...["apps", "mobile", "src-tauri", "gen", "android", "app", "src", "main", "res"],
);
const MIPMAPS = ["mipmap-mdpi", "mipmap-hdpi", "mipmap-xhdpi", "mipmap-xxhdpi", "mipmap-xxxhdpi"];
const LAUNCHER_FILES = ["ic_launcher.png", "ic_launcher_foreground.png", "ic_launcher_round.png"];

// --- PNG, ICO and ICNS reading (8-bit RGBA, non-interlaced: what `tauri icon` writes) ---------

interface Image {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (bytes: Buffer) => bytes.subarray(0, 8).equals(PNG_SIGNATURE);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(bytes: Buffer, what: string): Image {
  if (!isPng(bytes)) throw new Error(`${what} is not a PNG`);
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colourType, interlace] = [data[8], data[9], data[12]];
      if (depth !== 8 || colourType !== 6 || interlace !== 0) {
        throw new Error(
          `${what}: expected 8-bit RGBA without interlacing, got depth ${depth}, colour type ${colourType}, interlace ${interlace}`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= 4 ? (rgba[y * stride + x - 4] ?? 0) : 0;
      const b = y > 0 ? (rgba[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (rgba[(y - 1) * stride + x - 4] ?? 0) : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? (a + b) >> 1
                : filter === 4
                  ? paeth(a, b, c)
                  : Number.NaN;
      if (Number.isNaN(predictor)) throw new Error(`${what}: unknown PNG filter ${filter}`);
      rgba[y * stride + x] = (v + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}

/** The frames inside a Windows .ico (Tauri writes each as a PNG). */
function icoFrames(bytes: Buffer, what: string): Array<{ label: string; image: Image }> {
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const entry = 6 + 16 * i;
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    const label = `${what} frame ${bytes[entry] || 256}px`;
    return { label, image: decodePng(bytes.subarray(offset, offset + size), label) };
  });
}

/** The PNG entries inside a macOS .icns (the small RLE entries and masks are skipped). */
function icnsPngs(bytes: Buffer, what: string): Array<{ label: string; image: Image }> {
  if (bytes.toString("latin1", 0, 4) !== "icns") throw new Error(`${what} is not an icns file`);
  const out: Array<{ label: string; image: Image }> = [];
  for (let at = 8; at < bytes.length; ) {
    const type = bytes.toString("latin1", at, at + 4);
    const length = bytes.readUInt32BE(at + 4);
    const data = bytes.subarray(at + 8, at + length);
    if (isPng(data)) out.push({ label: `${what} ${type}`, image: decodePng(data, what) });
    at += length;
  }
  return out;
}

// --- what the design guarantees, at any size -------------------------------------------------

type Pixel = [number, number, number, number];

function pixel(img: Image, x: number, y: number): Pixel {
  const i = (y * img.width + x) * 4;
  const c = (k: number) => img.rgba[i + k] ?? -1;
  return [c(0), c(1), c(2), c(3)];
}

/** The kite's table at the centre: a dark mahogany red, fully opaque. */
const isMahogany = ([r, g, b, a]: Pixel) =>
  a === 255 && r >= 90 && r <= 200 && g <= 80 && b <= 80 && r >= 2 * g;

/** The tile just inside its edge: tan or cream (warm, light, fully opaque). */
const isTanOrCream = ([r, g, b, a]: Pixel) =>
  a === 255 && r >= 160 && g >= 130 && b >= 90 && r >= g && g >= b && r - b >= 30;

/**
 * Outside the rounded corners: transparent. A resampled corner pixel keeps a trace of the tile
 * at the smallest sizes (at 16 px it overlaps the rounded corner by a few percent), so "at most
 * an eighth opaque"; a square tile (a render that lost its transparency) is 255 there.
 */
const isTransparent = ([, , , a]: Pixel) => a < 32;

function designProblems(label: string, img: Image): string[] {
  const { width: w, height: h } = img;
  const cx = Math.floor((w - 1) / 2);
  const cy = Math.floor((h - 1) / 2);
  const inset = Math.max(1, Math.round(w * 0.04));
  const problems: string[] = [];
  const expectPixel = (what: string, x: number, y: number, ok: (p: Pixel) => boolean) => {
    const p = pixel(img, x, y);
    if (!ok(p)) problems.push(`${label} (${w}x${h}): ${what} at ${x},${y} is rgba(${p.join(",")})`);
  };
  expectPixel("the centre (mahogany)", cx, cy, isMahogany);
  expectPixel("the top edge (tan or cream)", cx, inset, isTanOrCream);
  expectPixel("the bottom edge (tan or cream)", cx, h - 1 - inset, isTanOrCream);
  expectPixel("the left edge (tan or cream)", inset, cy, isTanOrCream);
  expectPixel("the right edge (tan or cream)", w - 1 - inset, cy, isTanOrCream);
  for (const [x, y] of [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ] as const) {
    expectPixel("a corner (transparent)", x, y, isTransparent);
  }
  return problems;
}

/** Every picture a shipped icon file holds: the PNG itself, or each frame of an .ico or .icns. */
function picturesOf(file: string, what: string): Array<{ label: string; image: Image }> {
  const bytes = readFileSync(file);
  if (file.endsWith(".ico")) return icoFrames(bytes, what);
  if (file.endsWith(".icns")) return icnsPngs(bytes, what);
  return [{ label: what, image: decodePng(bytes, what) }];
}

function bundleIcons(tauriDir: string): string[] {
  const conf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8")) as {
    bundle?: { icon?: string[] };
  };
  return conf.bundle?.icon ?? [];
}

describe("the app icon (the owner's design of 2026-11-18)", () => {
  it("the master is the design the owner confirmed (regenerate the icon sets if it changes)", () => {
    expect(
      sha256(readFileSync(master)),
      "docs/design/icon/forerunner-icon.svg changed: regenerate every icon set from it (docs/maintainers/apps.md, 'The app icon') and update MASTER_SHA256",
    ).toBe(MASTER_SHA256);
  });

  for (const app of APPS) {
    describe(`${app.name}: the files tauri.conf.json lists`, () => {
      const listed = bundleIcons(app.tauri);

      it("lists the PNGs, the .ico and the .icns, each present", () => {
        expect(listed.filter((f) => f.endsWith(".png")).length).toBeGreaterThan(0);
        expect(listed.some((f) => f.endsWith(".ico"))).toBe(true);
        expect(listed.some((f) => f.endsWith(".icns"))).toBe(true);
        for (const f of listed) expect(existsSync(join(app.tauri, ...f.split("/"))), f).toBe(true);
      });

      it("show the kite: a mahogany centre, a tan or cream tile edge, transparent corners", () => {
        const problems = listed.flatMap((f) =>
          picturesOf(join(app.tauri, ...f.split("/")), `${app.name} ${f}`).flatMap((p) =>
            designProblems(p.label, p.image),
          ),
        );
        expect(problems).toEqual([]);
      });
    });

    describe(`${app.name}: the icons folder`, () => {
      const dir = join(app.tauri, "icons");

      it("holds the same files as before, no more and no fewer", () => {
        expect(readdirSync(dir).sort()).toEqual([...ICON_FILES].sort());
      });

      it("has no file left from Tauri's stock icon", () => {
        const stock = readdirSync(dir).filter((f) =>
          STOCK_SHA256.has(sha256(readFileSync(join(dir, f)))),
        );
        expect(stock).toEqual([]);
      });

      it("every PNG (the Windows tiles and the store logo too) shows the kite", () => {
        const problems = readdirSync(dir)
          .filter((f) => f.endsWith(".png"))
          .flatMap((f) => designProblems(`${app.name} icons/${f}`, decodePng(readFileSync(join(dir, f)), f)));
        expect(problems).toEqual([]);
      });
    });
  }

  describe("Android launcher icons (the phone's home screen)", () => {
    it("each density has its three launcher files, none of them Tauri's stock icon", () => {
      for (const m of MIPMAPS) {
        expect(readdirSync(join(androidRes, m)).sort(), m).toEqual(LAUNCHER_FILES);
        const stock = LAUNCHER_FILES.filter((f) =>
          STOCK_SHA256.has(sha256(readFileSync(join(androidRes, m, f)))),
        );
        expect(stock, m).toEqual([]);
      }
    });

    it("each launcher icon has the mahogany kite at its centre", () => {
      const problems: string[] = [];
      for (const m of MIPMAPS) {
        for (const f of LAUNCHER_FILES) {
          const img = decodePng(readFileSync(join(androidRes, m, f)), `${m}/${f}`);
          const p = pixel(img, Math.floor((img.width - 1) / 2), Math.floor((img.height - 1) / 2));
          if (!isMahogany(p)) problems.push(`${m}/${f}: the centre is rgba(${p.join(",")})`);
        }
      }
      expect(problems).toEqual([]);
    });
  });

  describe("the UI's browser tab", () => {
    const ui = join(repoRoot, "apps", "ui");

    it("index.html links an SVG favicon that is the master itself", () => {
      const html = readFileSync(join(ui, "index.html"), "utf8");
      const link = html.match(/<link\b[^>]*\brel="icon"[^>]*>/)?.[0];
      expect(link, "a <link rel=\"icon\"> in apps/ui/index.html").toBeDefined();
      expect(link).toMatch(/\btype="image\/svg\+xml"/);
      const href = link?.match(/\bhref="\/([^"]+)"/)?.[1];
      expect(href, "a root-relative href (Vite serves public/ at the root)").toBe("favicon.svg");
      // Vite copies public/ into dist/, which both Tauri shells load.
      const favicon = join(ui, "public", ...(href ?? "").split("/"));
      expect(existsSync(favicon), favicon).toBe(true);
      expect(sha256(readFileSync(favicon))).toBe(sha256(readFileSync(master)));
    });
  });
});
