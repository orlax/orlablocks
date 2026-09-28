import React, { useState, useEffect } from "react";

// Check if running inside Tauri webview
const isTauri = typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);

async function invokeTauri<T>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  // Browser preview fallback
  if (cmd === "get_status") {
    try {
      const res = await fetch("http://127.0.0.1:5170/api/health");
      return (await res.json()) as T;
    } catch {
      return { status: "stopped", port: 5170, dataDir: "~/Documents/Orlablocks" } as T;
    }
  }
  if (cmd === "open_editor") {
    window.open(`http://127.0.0.1:${args.port ?? 5170}`, "_blank");
    return true as T;
  }
  console.log(`[Browser Mock] Tauri command: ${cmd}`, args);
  return { success: true } as T;
}

interface ServerStatus {
  status: "ok" | "stopped" | "error";
  port: number;
  host: string;
  dataDir: string;
  open?: { project: { name: string }; scene: { name: string } } | null;
}

export function App() {
  const [status, setStatus] = useState<ServerStatus>({
    status: "ok",
    port: 5170,
    host: "127.0.0.1",
    dataDir: "~/Documents/Orlablocks",
    open: null,
  });
  const [activeTab, setActiveTab] = useState<"agents" | "skills">("agents");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastTimer, setToastTimer] = useState<any>(null);
  const [doneButtons, setDoneButtons] = useState<Record<string, string>>({});
  const [isRestarting, setIsRestarting] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    if (toastTimer) clearTimeout(toastTimer);
    const timer = setTimeout(() => setToastMessage(null), 2200);
    setToastTimer(timer);
  };

  const markButtonDone = (key: string, label: string) => {
    setDoneButtons((prev) => ({ ...prev, [key]: label }));
    setTimeout(() => {
      setDoneButtons((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, 2000);
  };

  const fetchStatus = async () => {
    try {
      const res = await invokeTauri<any>("get_status");
      if (res) {
        const port = res.port ?? status.port ?? 5170;
        let isHealthy = res.status === "ok";

        try {
          const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (healthRes.ok) {
            const healthData = await healthRes.json();
            if (healthData.status === "ok") {
              isHealthy = true;
            }
          }
        } catch {
          // If health check fails, keep res.status
        }

        const resolvedDataDir = res.dataDir ?? res.data_dir ?? status.dataDir;
        setStatus({
          status: isHealthy ? "ok" : "stopped",
          port,
          host: res.host ?? "127.0.0.1",
          dataDir: resolvedDataDir,
          open: res.open ?? null,
        });
      }
    } catch {
      // server might be restarting or stopped
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 2500);
    return () => clearInterval(interval);
  }, []);

  const copyText = (text: string, toast: string, btnKey?: string, doneLabel?: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    showToast(toast);
    if (btnKey && doneLabel) {
      markButtonDone(btnKey, doneLabel);
    }
  };

  const handleOpenEditor = async () => {
    await invokeTauri("open_editor", { port: status.port });
  };

  const handlePickDataDir = async () => {
    try {
      const newDir = await invokeTauri<string | null>("pick_data_dir");
      if (newDir) {
        setStatus((s) => ({ ...s, dataDir: newDir }));
        showToast("Folder updated & server restarted");
      }
    } finally {
      setTimeout(fetchStatus, 600);
    }
  };

  const handleOpenFinder = async () => {
    await invokeTauri("open_folder", { path: status.dataDir });
    showToast("Opened in Finder");
  };

  const handleRestart = async () => {
    setIsRestarting(true);
    setStatus((s) => ({ ...s, status: "stopped" }));
    try {
      await invokeTauri("restart_server");
      showToast("Server restarted");
    } finally {
      setTimeout(() => {
        setIsRestarting(false);
        fetchStatus();
      }, 1000);
    }
  };

  const handleInstallClaudeDesktop = async () => {
    try {
      const result = await invokeTauri<{ success: boolean; message: string }>("install_claude_desktop", { port: status.port });
      showToast(result?.message ? "Installed to Claude Desktop" : "Configuration updated");
      markButtonDone("claude-desktop-install", "Installed");
    } catch (err: any) {
      showToast(`Error: ${err}`);
    }
  };

  const handleInstallSkill = async () => {
    try {
      const result = await invokeTauri<{ success: boolean; message: string }>("install_skill");
      showToast(result?.message ? "Skill installed to agents" : "Skill installed");
      markButtonDone("skill-install", "Installed");
    } catch (err: any) {
      showToast(`Install failed: ${err}`);
    }
  };

  const handleExportSkill = async () => {
    try {
      const result = await invokeTauri<string | null>("export_skill_dialog");
      if (result) {
        showToast("Skill file saved to project");
        markButtonDone("skill-export", "Saved");
      }
    } catch (err: any) {
      showToast(`Export failed: ${err}`);
    }
  };

  const mcpUrl = `http://127.0.0.1:${status.port}/mcp`;
  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        orlablocks: {
          url: mcpUrl,
        },
      },
    },
    null,
    2
  );
  const claudeCodeCommand = `claude mcp add --transport http orlablocks ${mcpUrl}`;
  const ideConfig = claudeDesktopConfig;

  const isServerRunning = status.status === "ok";

  return (
    <div className="wrap">
      {/* Top Status & Restart */}
      <div className="top">
        <span className={`status ${!isServerRunning ? "off" : ""}`} role="status">
          <span className="dot" />
          <span>
            {isRestarting
              ? "Restarting…"
              : isServerRunning
              ? `Running on :${status.port}`
              : "Server stopped"}
          </span>
        </span>
        <button
          className="btn icon neutral"
          onClick={handleRestart}
          aria-label="Restart server"
          title="Restart server"
          disabled={isRestarting}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={isRestarting ? "spin" : ""}
          >
            <path d="M20 11a8 8 0 1 0-2.3 5.7" />
            <path d="M20 4v7h-7" />
          </svg>
        </button>
      </div>

      {/* Hero Header */}
      <header className="hero">
        <h1 aria-label="OrlaBlocks">
          <span className="orla" aria-hidden="true">Orla</span>
          <span className="blocks" aria-hidden="true">
            <span className="blk" style={{ "--c": "var(--mint)", "--cd": "var(--mint-d)", "--d": ".05s" } as any}>B</span>
            <span className="blk" style={{ "--c": "var(--peach)", "--cd": "var(--peach-d)", "--d": ".12s" } as any}>L</span>
            <span className="blk" style={{ "--c": "var(--coral)", "--cd": "var(--coral-d)", "--d": ".19s" } as any}>O</span>
            <span className="blk" style={{ "--c": "var(--lilac)", "--cd": "var(--lilac-d)", "--d": ".26s" } as any}>C</span>
            <span className="blk" style={{ "--c": "var(--sky)", "--cd": "var(--sky-d)", "--d": ".33s" } as any}>K</span>
            <span className="blk" style={{ "--c": "var(--leaf)", "--cd": "var(--leaf-d)", "--d": ".40s" } as any}>S</span>
          </span>
        </h1>
        <p className="tag">Block out your levels. Let your agents build with you.</p>
      </header>

      {/* Launch Button */}
      <button
        className="btn mint launch"
        onClick={handleOpenEditor}
        disabled={!isServerRunning}
      >
        <span className="big">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
            <path d="M12 2 21 7v10l-9 5-9-5V7Z" />
            <path d="M3 7l9 5 9-5M12 12v10" />
          </svg>
          Open 3D editor
        </span>
        <span className="small">Opens in your browser at 127.0.0.1:{status.port}</span>
      </button>

      {/* Data Folder Panel */}
      <section className="panel" aria-labelledby="folderTitle">
        <div className="panel-head">
          <h2 id="folderTitle">Your levels are saved in</h2>
        </div>
        <div className="folder-path">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h6l2 2h10v11H3Z" />
          </svg>
          <span id="path">{status.dataDir}</span>
        </div>
        <div className="row">
          <button className="btn neutral" onClick={handleOpenFinder}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-4-4" />
            </svg>
            Show in Finder
          </button>
          <button className="btn peach" onClick={handlePickDataDir}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
              <path d="M3 6h6l2 2h10v11H3Z" />
              <path d="M12 11v5M9.5 13.5h5" strokeLinecap="round" />
            </svg>
            Change folder
          </button>
        </div>
      </section>

      {/* Segmented Block Tabs */}
      <div className="tabs" role="tablist" aria-label="Setup">
        <button
          className="tab"
          role="tab"
          aria-selected={activeTab === "agents"}
          onClick={() => setActiveTab("agents")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
            <rect x="4" y="8" width="16" height="12" rx="3" />
            <path d="M12 4v4M9 13h.01M15 13h.01" strokeLinecap="round" />
          </svg>
          <span>Connect agents</span>
        </button>
        <button
          className="tab"
          role="tab"
          aria-selected={activeTab === "skills"}
          onClick={() => setActiveTab("skills")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
            <path d="M12 3l2.2 5.5L20 9l-4.4 3.8L17 19l-5-3.2L7 19l1.4-6.2L4 9l5.8-.5Z" />
          </svg>
          <span>Skill &amp; rules</span>
        </button>
      </div>

      {/* TAB 1: Connect Agents */}
      {activeTab === "agents" && (
        <div id="p-agents" role="tabpanel">
          {/* Claude Desktop */}
          <section className="panel agent">
            <div className="chip" style={{ "--c": "var(--coral)" } as any}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="13" rx="2.5" />
                <path d="M8 21h8M12 17v4" strokeLinecap="round" />
              </svg>
            </div>
            <div className="agent-body">
              <h2>Claude Desktop</h2>
              <p>One click adds OrlaBlocks to Claude's config. Restart Claude Desktop afterwards.</p>
            </div>
            <div className="agent-actions">
              <button
                className={`btn coral ${doneButtons["claude-desktop-install"] ? "done" : ""}`}
                onClick={handleInstallClaudeDesktop}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
                </svg>
                <span>{doneButtons["claude-desktop-install"] ?? "Install to Claude Desktop"}</span>
              </button>
            </div>
            <details>
              <summary>Set it up by hand</summary>
              <pre>{claudeDesktopConfig}</pre>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="btn neutral"
                  onClick={() => copyText(claudeDesktopConfig, "JSON copied", "copy-desktop-json", "Copied")}
                >
                  {doneButtons["copy-desktop-json"] ?? "Copy JSON"}
                </button>
              </div>
            </details>
          </section>

          {/* Claude Code */}
          <section className="panel agent">
            <div className="chip" style={{ "--c": "var(--lilac)" } as any}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 8 4 4-4 4M12 17h7" />
              </svg>
            </div>
            <div className="agent-body">
              <h2>Claude Code</h2>
              <p>Run this once in your terminal to register the server.</p>
            </div>
            <pre style={{ gridColumn: "1 / -1", margin: 0 }}>{claudeCodeCommand}</pre>
            <div className="agent-actions">
              <button
                className={`btn lilac ${doneButtons["copy-code-cmd"] ? "done" : ""}`}
                onClick={() => copyText(claudeCodeCommand, "Command copied", "copy-code-cmd", "Copied")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
                  <rect x="8" y="8" width="12" height="12" rx="2.5" />
                  <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                </svg>
                <span>{doneButtons["copy-code-cmd"] ?? "Copy command"}</span>
              </button>
            </div>
          </section>

          {/* Cursor, Windsurf & Antigravity */}
          <section className="panel agent">
            <div className="chip" style={{ "--c": "var(--sky)" } as any}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />
              </svg>
            </div>
            <div className="agent-body">
              <h2>
                Cursor, Windsurf &amp; Antigravity <span className="badge">mcp.json</span>
              </h2>
              <p>Paste this into your editor's MCP config file.</p>
            </div>
            <div className="agent-actions">
              <button
                className={`btn sky ${doneButtons["copy-ide-cfg"] ? "done" : ""}`}
                onClick={() => copyText(ideConfig, "Config copied", "copy-ide-cfg", "Copied")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
                  <rect x="8" y="8" width="12" height="12" rx="2.5" />
                  <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                </svg>
                <span>{doneButtons["copy-ide-cfg"] ?? "Copy config"}</span>
              </button>
            </div>
            <details>
              <summary>Show config</summary>
              <pre>{ideConfig}</pre>
            </details>
          </section>
        </div>
      )}

      {/* TAB 2: Skills & Rules */}
      {activeTab === "skills" && (
        <div id="p-skills" role="tabpanel">
          <section className="panel agent">
            <div className="chip" style={{ "--c": "var(--leaf)" } as any}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
                <path d="M5 4h11l3 3v13H5Z" />
                <path d="M9 11h6M9 15h4" strokeLinecap="round" />
              </svg>
            </div>
            <div className="agent-body">
              <h2>Level design skill</h2>
              <p>Teaches your agent how OrlaBlocks names volumes, paths and entities, so its edits match your layout.</p>
            </div>
            <div className="agent-actions">
              <button
                className={`btn leaf ${doneButtons["skill-install"] ? "done" : ""}`}
                onClick={handleInstallSkill}
              >
                <span>{doneButtons["skill-install"] ?? "Install skill"}</span>
              </button>
              <button
                className={`btn neutral ${doneButtons["skill-export"] ? "done" : ""}`}
                onClick={handleExportSkill}
              >
                <span>{doneButtons["skill-export"] ?? "Save as file"}</span>
              </button>
            </div>
          </section>

          <section className="panel agent">
            <div className="chip" style={{ "--c": "var(--peach)" } as any}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16M4 12h16M4 18h10" />
              </svg>
            </div>
            <div className="agent-body">
              <h2>Project rules</h2>
              <p>Grid size, scale and naming conventions for this project. Agents read these before they place anything.</p>
            </div>
            <div className="agent-actions">
              <button
                className="btn peach"
                onClick={() => copyText("Units: Meters (Y is up, ground is at Y=0)\nCompass: North is -Z, South is +Z, East is +X, West is -X\nShapes: box, cylinder, freeform, hole, ramp, line, note\nEntities: shared definitions in project library with world instances", "Rules copied", "copy-rules", "Copied")}
              >
                <span>{doneButtons["copy-rules"] ?? "Copy rules"}</span>
              </button>
            </div>
            <details>
              <summary>View core conventions</summary>
              <pre>{`Units: Meters (2 decimals), Y is up, ground at Y = 0
Compass: North is -Z, South is +Z, East is +X, West is -X
Shapes: box (centered x/z), cylinder, freeform, ramp, line
Holes: kind "hole" cuts shapes near it in group hierarchy
Entities: definitions in library, placed as instances with rotation`}</pre>
            </details>
          </section>
        </div>
      )}

      {/* Footer */}
      <footer>
        <span>
          MCP endpoint <code>127.0.0.1:{status.port}/mcp</code>
        </span>
        <span>OrlaBlocks v0.0.18</span>
      </footer>

      {/* Toast Notification */}
      <div className={`toast ${toastMessage ? "show" : ""}`} role="status" aria-live="polite">
        {toastMessage}
      </div>
    </div>
  );
}
