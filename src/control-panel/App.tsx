import React, { useState, useEffect } from "react";
import {
  Folder,
  FolderOpen,
  Play,
  Square,
  RotateCw,
  ExternalLink,
  Check,
  Copy,
  Bot,
  Sparkles,
  BookOpen,
  Terminal,
  ShieldCheck,
  AlertCircle
} from "lucide-react";

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
  mode?: "production" | "development";
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
  const [activeTab, setActiveTab] = useState<"agents" | "skill">("agents");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

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
    } catch (err) {
      // server might be restarting or stopped
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 2500);
    return () => clearInterval(interval);
  }, []);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleOpenEditor = async () => {
    await invokeTauri("open_editor", { port: status.port });
  };

  const handlePickDataDir = async () => {
    setIsProcessing(true);
    try {
      const newDir = await invokeTauri<string | null>("pick_data_dir");
      if (newDir) {
        setStatus((s) => ({ ...s, dataDir: newDir }));
        setActionMessage("Data directory updated. Server restarted.");
        setTimeout(() => setActionMessage(null), 3000);
      }
    } finally {
      setIsProcessing(false);
      setTimeout(fetchStatus, 600);
    }
  };

  const handleOpenFinder = async () => {
    await invokeTauri("open_folder", { path: status.dataDir });
  };

  const handleRestart = async () => {
    setIsProcessing(true);
    try {
      await invokeTauri("restart_server");
      setActionMessage("Server restarting...");
      setTimeout(() => setActionMessage(null), 2500);
    } finally {
      setIsProcessing(false);
      setTimeout(fetchStatus, 800);
    }
  };

  const handleInstallClaudeDesktop = async () => {
    setIsProcessing(true);
    try {
      const result = await invokeTauri<{ success: boolean; message: string }>("install_claude_desktop", { port: status.port });
      setActionMessage(result?.message ?? "Configured in Claude Desktop!");
      setTimeout(() => setActionMessage(null), 3500);
    } catch (err: any) {
      setActionMessage(`Failed: ${err}`);
      setTimeout(() => setActionMessage(null), 3500);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleInstallSkill = async () => {
    setIsProcessing(true);
    try {
      const result = await invokeTauri<{ success: boolean; message: string }>("install_skill");
      setActionMessage(result?.message ?? "Orlablocks Skill installed to ~/.gemini/antigravity/skills/orlablocks!");
      setTimeout(() => setActionMessage(null), 4000);
    } catch (err: any) {
      setActionMessage(`Install failed: ${err}`);
      setTimeout(() => setActionMessage(null), 3500);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExportSkill = async () => {
    setIsProcessing(true);
    try {
      const result = await invokeTauri<{ success: boolean; path: string }>("export_skill_dialog");
      if (result?.path) {
        setActionMessage(`Skill exported to ${result.path}`);
        setTimeout(() => setActionMessage(null), 3500);
      }
    } finally {
      setIsProcessing(false);
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
  const antigravityConfig = claudeDesktopConfig;

  return (
    <div className="container">
      {/* Header */}
      <header className="header">
        <div className="brand">
          <div className="brand-icon">
            <span style={{ fontWeight: 800, fontSize: 16, color: "#fff" }}>O</span>
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="brand-title">Orlablocks</span>
              <span className="brand-badge">Control Panel</span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className={`server-badge ${status.status === "ok" ? "running" : "stopped"}`}>
            <span className={`dot ${status.status === "ok" ? "pulse" : ""}`} />
            {status.status === "ok" ? `Running on :${status.port}` : "Stopped"}
          </div>

          <button className="btn btn-sm" onClick={handleRestart} title="Restart Server" disabled={isProcessing}>
            <RotateCw size={13} className={isProcessing ? "spin" : ""} />
          </button>
        </div>
      </header>

      {/* Primary Hero Action */}
      <button className="hero-action" onClick={handleOpenEditor} disabled={status.status !== "ok"}>
        <ExternalLink size={18} />
        Open 3D Editor in Browser
      </button>

      {/* Action Notification Message */}
      {actionMessage && (
        <div
          style={{
            background: "rgba(99, 102, 241, 0.2)",
            border: "1px solid rgba(99, 102, 241, 0.4)",
            color: "#c7d2fe",
            padding: "8px 12px",
            borderRadius: 6,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <CheckCircle2 size={14} color="#818cf8" />
          {actionMessage}
        </div>
      )}

      {/* Data Directory Card */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Folder size={14} /> Data Folder
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-sm" onClick={handleOpenFinder} title="Show in Finder / Explorer">
              Show in Finder
            </button>
            <button className="btn btn-sm btn-primary" onClick={handlePickDataDir} disabled={isProcessing}>
              <FolderOpen size={12} /> Change...
            </button>
          </div>
        </div>
        <div className="path-display">
          <span>{status.dataDir}</span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="tabs-nav">
        <button
          className={`tab-btn ${activeTab === "agents" ? "active" : ""}`}
          onClick={() => setActiveTab("agents")}
        >
          <Bot size={14} />
          Agents & MCP
        </button>
        <button
          className={`tab-btn ${activeTab === "skill" ? "active" : ""}`}
          onClick={() => setActiveTab("skill")}
        >
          <Sparkles size={14} />
          Skill & Rules
        </button>
      </div>

      {/* Tab 1: Agents & MCP */}
      {activeTab === "agents" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Claude Desktop */}
          <div className="agent-card">
            <div className="agent-card-header">
              <span className="agent-title">
                <Bot size={16} color="#f97316" />
                Claude Desktop
              </span>
              <button className="btn btn-sm btn-primary" onClick={handleInstallClaudeDesktop} disabled={isProcessing}>
                <ShieldCheck size={12} />
                Install to Claude Desktop
              </button>
            </div>
            <div style={{ position: "relative" }}>
              <pre className="snippet-box">{claudeDesktopConfig}</pre>
              <button
                className="snippet-copy-btn"
                onClick={() => copyToClipboard(claudeDesktopConfig, "claude-desktop")}
              >
                {copiedKey === "claude-desktop" ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                {copiedKey === "claude-desktop" ? "Copied" : "Copy JSON"}
              </button>
            </div>
          </div>

          {/* Claude Code CLI */}
          <div className="agent-card">
            <div className="agent-card-header">
              <span className="agent-title">
                <Terminal size={16} color="#a855f7" />
                Claude Code CLI
              </span>
            </div>
            <div style={{ position: "relative" }}>
              <pre className="snippet-box">{claudeCodeCommand}</pre>
              <button
                className="snippet-copy-btn"
                onClick={() => copyToClipboard(claudeCodeCommand, "claude-code")}
              >
                {copiedKey === "claude-code" ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                {copiedKey === "claude-code" ? "Copied" : "Copy Command"}
              </button>
            </div>
          </div>

          {/* Antigravity / Cursor / Windsurf */}
          <div className="agent-card">
            <div className="agent-card-header">
              <span className="agent-title">
                <Sparkles size={16} color="#3b82f6" />
                Antigravity / Cursor / Windsurf
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>mcp.json</span>
            </div>
            <div style={{ position: "relative" }}>
              <pre className="snippet-box">{antigravityConfig}</pre>
              <button
                className="snippet-copy-btn"
                onClick={() => copyToClipboard(antigravityConfig, "antigravity")}
              >
                {copiedKey === "antigravity" ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                {copiedKey === "antigravity" ? "Copied" : "Copy Config"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Skill & Rules */}
      {activeTab === "skill" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">
                <Sparkles size={14} color="#818cf8" />
                The Orlablocks Agent Skill
              </span>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Install the Orlablocks Skill into your AI agent so it natively understands 3D blockout rules,
              coordinate conventions (meters, north = -z), shapes, and entities without needing manual prompts.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button className="btn btn-primary" onClick={handleInstallSkill} disabled={isProcessing}>
                <Sparkles size={13} />
                Install Skill to Agent
              </button>
              <button className="btn" onClick={handleExportSkill} disabled={isProcessing}>
                <BookOpen size={13} />
                Export to Project Folder
              </button>
            </div>
          </div>

          <div className="card">
            <span className="card-title">Core Conventions Reference</span>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 6 }}>
              <div><strong>Units:</strong> Meters (2 decimals), Y is up, ground is at Y = 0.</div>
              <div><strong>Compass:</strong> North is -Z, South is +Z, East is +X, West is -X.</div>
              <div><strong>Shapes:</strong> Boxes, Cylinders, Freeforms (rooms, volumes, or holes).</div>
              <div><strong>Entities:</strong> Prefab components with shared definitions and world instances.</div>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="footer">
        <span>MCP Endpoint: {mcpUrl}</span>
        <span>Orlablocks v0.0.18</span>
      </footer>
    </div>
  );
}

function CheckCircle2(props: { size: number; color?: string }) {
  return <Check size={props.size} color={props.color ?? "currentColor"} />;
}
