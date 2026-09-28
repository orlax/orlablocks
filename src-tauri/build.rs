use std::fs;
use std::io::Write;
use std::path::Path;

fn main() {
    // With the `portable` feature (plan 11B), the server, the editor and Node go into the executable as a zip that
    // lib.rs unpacks on start.
    if std::env::var_os("CARGO_FEATURE_PORTABLE").is_some() {
        pack_payload();
    }
    tauri_build::build()
}

fn pack_payload() {
    let node = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") { "node.exe" } else { "node" };
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("payload.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&out).expect("create payload.zip"));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    for (source, name) in [("../dist/server", "dist/server"), ("../dist/web", "dist/web")] {
        println!("cargo:rerun-if-changed={source}");
        add_dir(&mut zip, Path::new(source), name, options);
    }
    let node_path = format!("binaries/{node}");
    println!("cargo:rerun-if-changed={node_path}");
    let bytes = fs::read(&node_path).unwrap_or_else(|_| panic!("{node_path} is missing: run node scripts/stage-node.mjs"));
    zip.start_file(node, options.unix_permissions(0o755)).unwrap();
    zip.write_all(&bytes).unwrap();
    zip.finish().unwrap();
}

fn add_dir(zip: &mut zip::ZipWriter<fs::File>, dir: &Path, name: &str, options: zip::write::SimpleFileOptions) {
    let entries = fs::read_dir(dir).unwrap_or_else(|_| panic!("{} is missing: run npm run build", dir.display()));
    for entry in entries {
        let path = entry.unwrap().path();
        let child = format!("{name}/{}", path.file_name().unwrap().to_string_lossy());
        if path.is_dir() {
            add_dir(zip, &path, &child, options);
        } else {
            zip.start_file(child, options).unwrap();
            zip.write_all(&fs::read(&path).unwrap()).unwrap();
        }
    }
}
