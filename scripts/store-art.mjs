// Composes the Figma Community cover (1920x960) and three carousel images (1920x1080) from the panel
// screenshots. Run `npm run screenshots` first.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const img = async (path) => `data:image/png;base64,${(await readFile(join(root, path))).toString("base64")}`;
const jpg = async (path) => `data:image/jpeg;base64,${(await readFile(join(root, path))).toString("base64")}`;

const shots = {
  signIn: await img("store/screenshots/light-sign-in.png"),
  generate: await img("store/screenshots/light-generate.png"),
  selection: await img("store/screenshots/light-selection.png"),
  progress: await img("store/screenshots/light-progress.png"),
  darkSelection: await img("store/screenshots/dark-selection.png"),
};
const mark = await img("assets/mark-96.png");
const before = await jpg("scripts/fixtures/perfume-before.jpg");
const after = await jpg("scripts/fixtures/perfume-after.jpg");

const base = (w, h, body) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Gabarito:wght@700;800&display=swap">
<style>
*{box-sizing:border-box}html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden}
body{background:#FAF4E8;color:#352242;font-family:Gabarito,system-ui,sans-serif;position:relative}
.panel{position:absolute;width:340px;height:600px;border-radius:14px;overflow:hidden;box-shadow:0 40px 80px -40px rgba(53,34,66,.45),0 0 0 1px rgba(53,34,66,.12);background:#fff}
.panel img{width:340px;height:600px;display:block}
.chrome{position:absolute;inset:0 auto auto 0;height:28px;width:100%;background:#2c2c2c;color:#fff;font:600 12px system-ui;display:flex;align-items:center;padding:0 12px}
h1{font-weight:800;letter-spacing:-.04em;line-height:.98;margin:0}
.brand{display:flex;align-items:center;gap:14px;font-weight:800;font-size:40px;letter-spacing:-.03em}
.brand img{width:56px;height:56px}
.canvas{position:absolute;background:#F3F3F3;background-image:radial-gradient(rgba(0,0,0,.08) 1px,transparent 1px);background-size:22px 22px;border-radius:24px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(53,34,66,.1)}
.frame{position:absolute;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.frame img{width:100%;height:100%;object-fit:cover;display:block}
.label{position:absolute;font:500 13px system-ui;color:#6b6b6b}
.sel{outline:2px solid #0D99FF;outline-offset:0}
</style></head><body>${body}</body></html>`;

// A canvas with the source layer and a real PopNow edit of it placed next to it (no filters standing in for results).
const canvas = (x, y, w, h, size = 360) => {
  const left = Math.round((w - size * 2 - 48) / 2);
  const top = Math.round(h / 2 - size / 2);
  return `
<div class="canvas" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">
  <div class="label" style="left:${left}px;top:${top - 24}px">Perfume hero</div>
  <div class="frame sel" style="left:${left}px;top:${top}px;width:${size}px;height:${size}px"><img src="${before}"></div>
  <div class="label" style="left:${left + size + 48}px;top:${top - 24}px">PopNow · Edit image</div>
  <div class="frame" style="left:${left + size + 48}px;top:${top}px;width:${size}px;height:${size}px"><img src="${after}"></div>
</div>`;
};

const pages = {
  "cover-1920x960": base(1920, 960, `
    <div style="position:absolute;left:120px;top:150px;width:720px">
      <div class="brand"><img src="${mark}">PopNow</div>
      <h1 style="font-size:96px;margin-top:48px">Generate and edit images on your canvas</h1>
      <p style="font:700 30px/1.35 Gabarito;margin:40px 0 0;opacity:.72;max-width:640px">Prices in credits on every button. Results land as new layers.</p>
    </div>
    ${canvas(860, 140, 620, 680, 262)}
    <div class="panel" style="left:1500px;top:180px"><img src="${shots.selection}"></div>`),
  "carousel-1-generate": base(1920, 1080, `
    <div style="position:absolute;left:140px;top:380px;width:720px"><h1 style="font-size:92px">Generate</h1>
    <p style="font:700 32px/1.35 Gabarito;opacity:.7;margin:28px 0 0">Prompt, shape and model. The price is on the button.</p></div>
    <div class="panel" style="left:1180px;top:240px;transform:scale(1)"><img src="${shots.generate}"></div>`),
  "carousel-2-selection": base(1920, 1080, `
    ${canvas(80, 160, 980, 760)}
    <div style="position:absolute;left:1180px;top:110px;font:800 56px Gabarito;letter-spacing:-.03em">Edit the selected layer</div>
    <div class="panel" style="left:1180px;top:240px"><img src="${shots.selection}"></div>
    <div class="panel" style="left:1560px;top:240px"><img src="${shots.darkSelection}"></div>`),
  "carousel-3-sign-in": base(1920, 1080, `
    <div style="position:absolute;left:140px;top:380px;width:760px"><h1 style="font-size:92px">Your PopNow credits</h1>
    <p style="font:700 32px/1.35 Gabarito;opacity:.7;margin:28px 0 0">Sign in once. Same balance and prices as popnow.ai.</p></div>
    <div class="panel" style="left:1060px;top:240px"><img src="${shots.signIn}"></div>
    <div class="panel" style="left:1440px;top:240px"><img src="${shots.progress}"></div>`),
};

const tmp = await mkdtemp(join(tmpdir(), "popnow-figma-art-"));
const profile = await mkdtemp(join(tmpdir(), "popnow-figma-art-profile-"));
try {
  for (const [name, html] of Object.entries(pages)) {
    const [w, h] = name.startsWith("cover") ? [1920, 960] : [1920, 1080];
    const file = join(tmp, `${name}.html`);
    await writeFile(file, html);
    execFileSync(CHROME, [
      "--headless=new", `--user-data-dir=${profile}`, "--hide-scrollbars", "--force-color-profile=srgb",
      `--window-size=${w},${h}`, "--virtual-time-budget=4000", `--screenshot=${join(root, "store", `${name}.png`)}`, pathToFileURL(file).href,
    ], { stdio: "ignore" });
    console.log(`store/${name}.png`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
