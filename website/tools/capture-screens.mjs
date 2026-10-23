// Captures real product screenshots for the marketing site, against a throwaway
// profile + a disposable demo workspace, using a LOCAL model (Ollama) so the
// transcript is genuine but contains no proprietary data, keys, or cost.
//
//   ollama serve &                       # must be running
//   DEMO_DIR=/path/to/demo SHOT_DIR=/path/to/out \
//   node website/tools/capture-screens.mjs
//
// Launch once to let the app write a full settings.json, patch it (dark theme, demo
// workspace, local model, read-only plan mode, onboarding finished), then relaunch for
// the model picker in each theme (the site shows the one matching its theme), both
// before any chat exists so they show the same screen. Last, drive a real read-only
// task for the transcript shot.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { _electron as electron } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const OUT = process.env.SHOT_DIR || join(tmpdir(), "houston-shots");
const DEMO = process.env.DEMO_DIR;
const MODEL = process.env.MODEL || "qwen2.5-coder:latest";
if (!DEMO) throw new Error("set DEMO_DIR to a demo workspace path");
mkdirSync(OUT, { recursive: true });

const MAIN = join(ROOT, "out", "main", "index.js");
const userDataDir = mkdtempSync(join(tmpdir(), "houston-shots-"));

async function boot() {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [MAIN, `--user-data-dir=${userDataDir}`],
  });
  const win = await app.firstWindow();
  await win.locator(".app").waitFor({ state: "visible" });
  return { app, win };
}

// Phase A — have the app persist a full default settings.json, then close. The app
// only writes settings on a change, so round-trip its defaults through the save IPC.
{
  const { app, win } = await boot();
  await win.evaluate(async () => window.api.saveSettings(await window.api.getSettings()));
  await app.close();
}

// Patch settings: dark theme, demo workspace, local model selected, plan mode, and
// onboarding marked done so no get-started checklist or tip sits behind the picker.
const settingsPath = join(userDataDir, "settings.json");
const s = JSON.parse(readFileSync(settingsPath, "utf8"));
s.theme = "dark";
s.recentWorkspaces = [DEMO];
s.approvalPolicy = "plan";
// TIP_IDS in src/shared/onboarding.ts; unknown ids are ignored.
s.onboarding = { checklistDone: true, seenTips: ["approval", "worktree", "context", "steer", "changes", "revert"] };
const ollama = (s.providers || []).find((p) => p.id === "ollama");
if (!ollama) throw new Error("no ollama provider in settings");
ollama.models = [{ id: MODEL, label: MODEL.replace(":latest", "") }];
s.selected = { providerId: "ollama", model: MODEL };
writeFileSync(settingsPath, JSON.stringify(s, null, 2));

function setTheme(theme) {
  const next = JSON.parse(readFileSync(settingsPath, "utf8"));
  next.theme = theme;
  writeFileSync(settingsPath, JSON.stringify(next, null, 2));
}

async function bootSized() {
  const booted = await boot();
  await booted.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1360, 880)
  );
  await booted.win.waitForTimeout(1000);
  return booted;
}

// Model picker open: showcases multi-provider + capability badges.
async function pickerShot(win, theme) {
  await win.locator(".model-control").first().click();
  await win.locator(".model-menu").first().waitFor({ state: "visible", timeout: 5000 });
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(OUT, `shot-modelpicker-${theme}.png`) });
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);
}

// Phase B: the empty window and the model picker, in each theme.
for (const theme of ["dark", "light"]) {
  setTheme(theme);
  const { app, win } = await bootSized();
  if (theme === "dark") await win.screenshot({ path: join(OUT, "shot-empty-dark.png") });
  await pickerShot(win, theme);
  await app.close();
}

// Phase C: relaunch in the dark theme and drive a real task.
setTheme("dark");
const { app, win } = await bootSized();
const prompt =
  "Read the code in this project and explain how theming works — which files are involved and what each does.";
const box = win.locator(".composer textarea").first();
await box.click();
await box.fill(prompt);
await win.screenshot({ path: join(OUT, "shot-composer.png") });
await box.press("Enter");

// Wait for the run: assistant content grows, then the composer re-enables.
const baseline = (await win.evaluate(() => document.body.innerText)).length;
const deadline = Date.now() + 150000;
let grew = false;
while (Date.now() < deadline) {
  await win.waitForTimeout(2500);
  const len = (await win.evaluate(() => document.body.innerText)).length;
  const tools = await win.locator(".tool-row").count().catch(() => 0);
  const running = await win.getByRole("button", { name: /stop/i }).isVisible().catch(() => false);
  if (len > baseline + 200) grew = true;
  console.log(`  …len=${len} tools=${tools} running=${running}`);
  if (grew && !running) break;
}
await win.waitForTimeout(1500);
await win.evaluate(() => window.scrollTo(0, 0));
await win.screenshot({ path: join(OUT, "shot-transcript.png") });

await app.close();

console.log("done ->", OUT);
