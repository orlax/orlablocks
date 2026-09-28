use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

#[derive(Debug, Serialize, Deserialize, Clone)]
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
pub struct ServerStatus {
    pub status: String,
    pub port: u16,
    pub host: String,
    pub data_dir: String,
}

#[derive(Serialize)]
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

fn find_server_entry() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("dist/server/main.js"),
        PathBuf::from("../dist/server/main.js"),
    ];
    for c in candidates {
        if c.exists() {
            return Some(fs::canonicalize(&c).unwrap_or(c));
        }
    }
    None
}

fn spawn_child(data_dir: &str, port: u16) -> Option<Child> {
    let script = find_server_entry()?;
    let _ = fs::create_dir_all(data_dir);
    Command::new("node")
        .arg(&script)
        .arg("--port")
        .arg(port.to_string())
        .arg("--data")
        .arg(data_dir)
        .spawn()
        .ok()
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

#[tauri::command]
fn stop_server(state: State<'_, ServerState>) -> bool {
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

pub fn run() {
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
                let state: State<'_, ServerState> = window.state();
                let mut child_guard = state.child.lock().unwrap();
                if let Some(ref mut child) = *child_guard {
                    let _ = child.kill();
                    let _ = child.wait();
                    *child_guard = None;
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
