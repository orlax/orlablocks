use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub data_dir: String,
    pub port: u16,
    pub recent_data_dirs: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        let docs = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
        let default_data = docs.join("Orlablocks").to_string_lossy().to_string();
        Self {
            data_dir: default_data.clone(),
            port: 5170,
            recent_data_dirs: vec![default_data],
        }
    }
}

pub struct ServerState {
    pub child: Mutex<Option<Child>>,
    pub config: Mutex<AppConfig>,
    pub active_port: Mutex<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub status: String,
    pub port: u16,
    pub host: String,
    pub data_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub success: bool,
    pub message: String,
}

const SKILL_CONTENT: &str = include_str!("../../skills/orlablocks/SKILL.md");

fn config_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".orlablocks").join("config.json")
}

fn load_config() -> AppConfig {
    let p = config_path();
    if let Ok(content) = fs::read_to_string(&p) {
        if let Ok(cfg) = serde_json::from_str::<AppConfig>(&content) {
            return cfg;
        }
    }
    let default_cfg = AppConfig::default();
    save_config(&default_cfg);
    default_cfg
}

fn save_config(cfg: &AppConfig) {
    let p = config_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        let _ = fs::write(p, json);
    }
}

/// Node's file name in the bundle.
const NODE: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// Where the bundled server and Node are (plans 11 and 11B): a macOS app's `Contents/Resources`, the folder of the
/// Windows `.exe` (where the installer puts them), and, for the portable `.exe`, what it unpacked from itself.
fn bundle_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            #[cfg(target_os = "macos")]
            if let Some(contents) = dir.parent() {
                dirs.push(contents.join("Resources"));
            }
            #[cfg(not(target_os = "macos"))]
            dirs.push(dir.to_path_buf());
        }
    }
    #[cfg(feature = "portable")]
    if let Some(dir) = portable::runtime_dir() {
        dirs.push(dir.clone());
    }
    dirs
}

fn find_node_binary() -> Option<PathBuf> {
    // 1. The Node in the bundle.
    for dir in bundle_dirs() {
        let embedded = dir.join(NODE);
        if embedded.exists() {
            return Some(embedded);
        }
    }
    // 2. One on this machine (development, or a bundle without one).
    system_node()
}

#[cfg(windows)]
fn system_node() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    let output = Command::new("where").arg("node").creation_flags(CREATE_NO_WINDOW).output().ok()?;
    let first = String::from_utf8_lossy(&output.stdout).lines().next()?.trim().to_string();
    let p = PathBuf::from(first);
    p.exists().then_some(p)
}

#[cfg(not(windows))]
fn system_node() -> Option<PathBuf> {
    // The user's login shell: zsh -l -c "which node" (inherits nvm, volta, fnm, brew)
    if let Ok(output) = Command::new("zsh").args(["-l", "-c", "which node"]).output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() {
                let p = PathBuf::from(path_str);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    // Common Homebrew / system paths
    let common_paths = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for p in common_paths {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }

    // NVM's newest installed version
    if let Some(home) = dirs::home_dir() {
        let nvm_dir = home.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(nvm_dir) {
            let mut versions: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.is_dir())
                .collect();
            versions.sort();
            if let Some(latest) = versions.pop() {
                let node_bin = latest.join("bin/node");
                if node_bin.exists() {
                    return Some(node_bin);
                }
            }
        }
    }

    None
}

fn find_server_entry() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = bundle_dirs().iter().map(|d| d.join("dist/server/main.js")).collect();

    // In local development / repo:
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("dist/server/main.js"));
        candidates.push(cwd.join("../dist/server/main.js"));
    }

    for c in candidates {
        if c.exists() {
            // Not on Windows: canonicalize gives a `\\?\C:\...` path there, which Node can't load a script from
            // (the paths are absolute already).
            #[cfg(windows)]
            return Some(c);
            #[cfg(not(windows))]
            return Some(fs::canonicalize(&c).unwrap_or(c));
        }
    }
    None
}

/// Windows' flag for a child process without a console window (Node would open one next to the Control Panel).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The portable Windows `.exe` (plan 11B): the server, the editor and Node are a zip inside the executable
/// (`build.rs`), unpacked once per version to `%LOCALAPPDATA%\Orlablocks\runtime\<version>`.
#[cfg(feature = "portable")]
mod portable {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    static PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.zip"));

    /// The unpacked folder, unpacking it on first use (once per run).
    pub fn runtime_dir() -> Option<&'static PathBuf> {
        static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
        DIR.get_or_init(unpack).as_ref()
    }

    fn unpack() -> Option<PathBuf> {
        unpack_into(&dirs::data_local_dir()?.join("Orlablocks").join("runtime"))
    }

    pub(super) fn unpack_into(base: &std::path::Path) -> Option<PathBuf> {
        let version = env!("CARGO_PKG_VERSION");
        let dir = base.join(version);
        // A folder is only used once complete: it's unpacked beside it, marked, then renamed into place.
        if dir.join(".complete").exists() {
            return Some(dir);
        }
        let partial = base.join(format!("{version}.partial-{}", std::process::id()));
        let _ = fs::remove_dir_all(&partial);
        fs::create_dir_all(&partial).ok()?;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(PAYLOAD)).ok()?;
        archive.extract(&partial).ok()?;
        fs::write(partial.join(".complete"), version).ok()?;
        let _ = fs::remove_dir_all(&dir);
        fs::rename(&partial, &dir).ok()?;
        Some(dir)
    }
}

fn spawn_child(data_dir: &str, port: u16) -> Option<Child> {
    let node_bin = find_node_binary()?;
    let script = find_server_entry()?;
    let _ = fs::create_dir_all(data_dir);

    let log_file = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".orlablocks/server.log");
    if let Some(p) = log_file.parent() {
        let _ = fs::create_dir_all(p);
    }

    let log_out = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .ok()?;
    let log_err = log_out.try_clone().ok()?;

    let mut command = Command::new(node_bin);
    command
        .arg(&script)
        .arg("--port")
        .arg(port.to_string())
        .arg("--data")
        .arg(data_dir)
        .stdout(log_out)
        .stderr(log_err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().ok()
}

#[tauri::command]
fn get_status(state: State<'_, ServerState>) -> ServerStatus {
    let cfg = state.config.lock().unwrap().clone();
    let port = *state.active_port.lock().unwrap();
    let mut child_guard = state.child.lock().unwrap();

    let is_running = if let Some(ref mut child) = *child_guard {
        match child.try_wait() {
            Ok(None) => true,
            _ => false,
        }
    } else {
        false
    };

    ServerStatus {
        status: if is_running { "ok".to_string() } else { "stopped".to_string() },
        port,
        host: "127.0.0.1".to_string(),
        data_dir: cfg.data_dir,
    }
}

#[tauri::command]
fn open_editor(port: u16) {
    let url = format!("http://127.0.0.1:{}", port);
    let _ = open::that(url);
}

#[tauri::command]
fn open_folder(path: String) {
    let _ = open::that(path);
}

#[tauri::command]
fn pick_data_dir(state: State<'_, ServerState>) -> Option<String> {
    let dialog = rfd::FileDialog::new();
    if let Some(folder) = dialog.pick_folder() {
        let path_str = folder.to_string_lossy().to_string();
        {
            let mut cfg = state.config.lock().unwrap();
            cfg.data_dir = path_str.clone();
            if !cfg.recent_data_dirs.contains(&path_str) {
                cfg.recent_data_dirs.insert(0, path_str.clone());
            }
            save_config(&cfg);
        }
        restart_server_internal(&state);
        Some(path_str)
    } else {
        None
    }
}

fn restart_server_internal(state: &ServerState) {
    let (data_dir, port) = {
        let cfg = state.config.lock().unwrap();
        (cfg.data_dir.clone(), cfg.port)
    };

    let mut child_guard = state.child.lock().unwrap();
    if let Some(ref mut child) = *child_guard {
        let _ = child.kill();
        let _ = child.wait();
    }
    *child_guard = spawn_child(&data_dir, port);
}

#[tauri::command]
fn restart_server(state: State<'_, ServerState>) -> bool {
    restart_server_internal(&state);
    true
}

/// Stops the server if it's running; false if there was none.
fn stop_child(state: &ServerState) -> bool {
    let mut child_guard = state.child.lock().unwrap();
    if let Some(ref mut child) = *child_guard {
        let _ = child.kill();
        let _ = child.wait();
        *child_guard = None;
        true
    } else {
        false
    }
}

#[tauri::command]
fn stop_server(state: State<'_, ServerState>) -> bool {
    stop_child(&state)
}

#[tauri::command]
fn install_claude_desktop(port: u16) -> Result<ActionResult, String> {
    let home = dirs::home_dir().ok_or("Cannot locate user home directory")?;
    #[cfg(target_os = "macos")]
    let config_path = home.join("Library/Application Support/Claude/claude_desktop_config.json");
    #[cfg(target_os = "windows")]
    let config_path = dirs::config_dir().ok_or("Cannot locate appdata")?.join("Claude/claude_desktop_config.json");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let config_path = home.join(".config/Claude/claude_desktop_config.json");

    if let Some(parent) = config_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut root: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !root.is_object() {
        root = serde_json::json!({});
    }

    if let Some(map) = root.as_object_mut() {
        let servers = map.entry("mcpServers".to_string()).or_insert_with(|| serde_json::json!({}));
        if let Some(servers_obj) = servers.as_object_mut() {
            servers_obj.insert(
                "orlablocks".to_string(),
                serde_json::json!({
                    "url": format!("http://127.0.0.1:{}/mcp", port)
                }),
            );
        }
    }

    let formatted = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    fs::write(&config_path, formatted).map_err(|e| e.to_string())?;

    Ok(ActionResult {
        success: true,
        message: format!("Successfully added orlablocks to Claude Desktop!"),
    })
}

#[tauri::command]
fn install_skill() -> Result<ActionResult, String> {
    let home = dirs::home_dir().ok_or("Cannot locate user home directory")?;
    let gemini_skill_dir = home.join(".gemini/antigravity/skills/orlablocks");
    let claude_skill_dir = home.join(".claude/skills/orlablocks");

    let _ = fs::create_dir_all(&gemini_skill_dir);
    let _ = fs::write(gemini_skill_dir.join("SKILL.md"), SKILL_CONTENT);

    let _ = fs::create_dir_all(&claude_skill_dir);
    let _ = fs::write(claude_skill_dir.join("SKILL.md"), SKILL_CONTENT);

    Ok(ActionResult {
        success: true,
        message: "Skill installed to ~/.gemini/antigravity/skills/orlablocks!".to_string(),
    })
}

#[tauri::command]
fn export_skill_dialog() -> Option<String> {
    let dialog = rfd::FileDialog::new();
    if let Some(folder) = dialog.pick_folder() {
        let target = folder.join("orlablocks-SKILL.md");
        if fs::write(&target, SKILL_CONTENT).is_ok() {
            Some(target.to_string_lossy().to_string())
        } else {
            None
        }
    } else {
        None
    }
}

/// Windows needs Microsoft's WebView2 for the Control Panel's window. Windows 11 has it, and Windows 10 gets it with
/// its updates; the installer adds it if missing, but the portable `.exe` can't, so it says so instead of failing
/// silently (plan 11B).
#[cfg(windows)]
fn webview2_missing() -> bool {
    if tauri::webview_version().is_ok() {
        return false;
    }
    let download = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("OrlaBlocks needs Microsoft WebView2")
        .set_description("OrlaBlocks' window uses Microsoft Edge WebView2, which isn't installed on this PC. Install the WebView2 Runtime (free, from Microsoft), then open OrlaBlocks again.\n\nOpen the download page now?")
        .set_buttons(rfd::MessageButtons::YesNo)
        .show();
    if download == rfd::MessageDialogResult::Yes {
        let _ = open::that("https://developer.microsoft.com/microsoft-edge/webview2/");
    }
    true
}

pub fn run() {
    #[cfg(windows)]
    if webview2_missing() {
        return;
    }
    let config = load_config();
    let port = config.port;
    let initial_child = spawn_child(&config.data_dir, port);

    let state = ServerState {
        child: Mutex::new(initial_child),
        config: Mutex::new(config),
        active_port: Mutex::new(port),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_status,
            open_editor,
            open_folder,
            pick_data_dir,
            restart_server,
            stop_server,
            install_claude_desktop,
            install_skill,
            export_skill_dialog
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                stop_child(&window.state::<ServerState>());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Quitting the app (Cmd+Q, the dock's Quit) can end it without destroying the window first, which would
        // leave the server running on its own, holding the port and the data folder's lock.
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_child(&app.state::<ServerState>());
            }
        });
}

#[cfg(all(test, feature = "portable"))]
mod tests {
    use super::portable::unpack_into;

    #[test]
    fn unpacks_the_payload_once_into_a_complete_folder() {
        let base = std::env::temp_dir().join(format!("orla-runtime-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = unpack_into(&base).expect("unpacked");
        assert!(dir.join("dist/server/main.js").exists());
        assert!(dir.join("dist/web/index.html").exists());
        assert!(dir.join(super::NODE).exists());
        assert!(dir.join(".complete").exists());
        // Unpacked already: the same folder, and no partial one left beside it.
        assert_eq!(unpack_into(&base).expect("again"), dir);
        let left: Vec<_> = std::fs::read_dir(&base).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left.len(), 1, "{left:?}");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
