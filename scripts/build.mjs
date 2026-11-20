// Builds dist/code.js (main thread) and dist/ui.html (one self-contained page) for the Figma manifest.
import { build, context } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const watch = process.argv.includes("--watch");
// For local testing against a fake server: POPNOW_MCP_URL=http://127.0.0.1:8787/mcp npm run build
const define = {
  __VERSION__: JSON.stringify(pkg.version),
  __MCP_URL__: JSON.stringify(process.env.POPNOW_MCP_URL ?? ""),
  __RELAY_URL__: JSON.stringify(process.env.POPNOW_RELAY_URL ?? ""),
};
await mkdir(join(root, "dist"), { recursive: true });

async function icons() {
  const out = await build({ entryPoints: [join(root, "src/ui/icons.ts")], bundle: true, format: "esm", write: false });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
  return mod.ICONS;
}

async function page() {
  const [template, css, js, mark, ICONS] = await Promise.all([
    readFile(join(root, "src/ui/index.html"), "utf8"),
    readFile(join(root, "src/ui/styles.css"), "utf8"),
    build({
      entryPoints: [join(root, "src/ui/main.ts")],
      bundle: true,
      format: "iife",
      target: "es2020",
      minify: true,
      write: false,
      define,
    }).then((r) => r.outputFiles[0].text),
    readFile(join(root, "assets/mark-96.png")),
    icons(),
  ]);
  const images = {};
  for (const name of ["headphones", "perfume", "watch-dramatic"]) {
    images[name] = (await readFile(join(root, `assets/${name}.jpg`))).toString("base64");
  }
  const html = template
    .replaceAll("%%MARK%%", `data:image/png;base64,${mark.toString("base64")}`)
    .replace(/%%IMG:([\w-]+)%%/g, (_, name) => `data:image/jpeg;base64,${images[name]}`)
    .replace(/%%ICON:(\w+)%%/g, (_, name) => {
      if (!ICONS[name]) throw new Error(`unknown icon ${name}`);
      return ICONS[name];
    })
    .replace("/*STYLES*/", () => css)
    .replace("/*SCRIPT*/", () => js.replace(/<\/script/gi, "<\\/script"));
  await writeFile(join(root, "dist/ui.html"), html);
}

const main = {
  entryPoints: [join(root, "src/code.ts")],
  bundle: true,
  format: "iife",
  // The plugin sandbox runs modern JavaScript, but keep the syntax conservative.
  target: "es2017",
  outfile: join(root, "dist/code.js"),
  define,
  logLevel: "warning",
};

if (watch) {
  const ctx = await context(main);
  await ctx.watch();
  const { watch: fsWatch } = await import("node:fs");
  fsWatch(join(root, "src"), { recursive: true }, () => page().catch((e) => console.error(e.message)));
  await page();
  console.log("watching src/ …");
} else {
  await Promise.all([build(main), page()]);
  console.log("built dist/code.js and dist/ui.html");
}
