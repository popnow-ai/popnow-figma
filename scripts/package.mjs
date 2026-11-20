// Zips the files Figma needs (manifest.json + dist/) into popnow-figma-<version>.zip.
// Unzip it anywhere and use Figma desktop > Plugins > Development > Import plugin from manifest.
import { execFileSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
for (const file of [manifest.main, manifest.ui]) await stat(join(root, file)); // built?
const zip = `popnow-figma-${version}.zip`;
await rm(join(root, zip), { force: true });
execFileSync("zip", ["-q", "-X", zip, "manifest.json", manifest.main, manifest.ui, "LICENSE"], { cwd: root, stdio: "inherit" });
console.log(zip);
