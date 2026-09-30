import { execFile } from "node:child_process";
import fs from "node:fs";

/**
 * The system's folder dialog, opened by the server (15.2): the editor runs in a browser, which can't give a folder's
 * path, and the export needs one (it runs on the server, after every step and for the agent). macOS uses
 * AppleScript's `choose folder`, Windows the Forms folder dialog, Linux zenity or kdialog. Resolves to the folder, or
 * null if the human cancels.
 */

const PROMPT = "Choose the folder to export to Unity in (each scene gets a folder of its own in it)";

/** Runs a command; resolves to its output, or null when it exits with a failure (a cancelled dialog). */
function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 10 * 60 * 1000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
      resolve(err ? null : stdout.trim());
    }),
  );
}

const quoteAppleScript = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export async function pickFolder(start?: string): Promise<string | null> {
  const from = start && fs.existsSync(start) ? start : undefined;
  if (process.platform === "darwin") {
    // `activate` brings the dialog in front of the browser.
    const where = from ? ` default location (POSIX file ${quoteAppleScript(from)})` : "";
    const out = await run("osascript", ["-e", "activate", "-e", `POSIX path of (choose folder with prompt ${quoteAppleScript(PROMPT)}${where})`]);
    return out ? out.replace(/\/$/, "") || "/" : null;
  }
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$d.Description = '${PROMPT.replace(/'/g, "''")}'`,
      "$d.ShowNewFolderButton = $true",
      ...(from ? [`$d.SelectedPath = '${from.replace(/'/g, "''")}'`] : []),
      "if ($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost = $true})) -eq 'OK') { $d.SelectedPath } else { exit 1 }",
    ].join("; ");
    return (await run("powershell.exe", ["-NoProfile", "-STA", "-Command", script])) || null;
  }
  try {
    return (await run("zenity", ["--file-selection", "--directory", `--title=${PROMPT}`, ...(from ? [`--filename=${from}/`] : [])])) || null;
  } catch {
    try {
      return (await run("kdialog", ["--getexistingdirectory", from ?? process.env.HOME ?? "/", "--title", PROMPT])) || null;
    } catch {
      throw new Error("No folder dialog is available here (install zenity or kdialog).");
    }
  }
}
