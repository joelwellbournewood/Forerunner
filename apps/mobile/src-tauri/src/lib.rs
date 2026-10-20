//! The Forerunner Android shell (spec R, ADR 0026, ADR 0032): a thin Tauri 2 wrapper around
//! the shared React UI. It never reaches a PC's daemon; the UI pairs with the shared state
//! service. The shell owns what the WebView must not: the device key (wrapped by the
//! Android Keystore), the session token store, the biometric prompt, the `fr://` pairing
//! link and the push status. Desktop builds of this crate exist for `cargo test` and dev
//! runs; they use file-mode protection and no biometric prompt, and say so.

mod biometric;
mod commands;
mod config;
mod dirs;
mod keystore;
mod push;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_deep_link::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      #[cfg(any(target_os = "android", target_os = "ios"))]
      {
        app.handle().plugin(tauri_plugin_biometric::init())?;
        app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
      }
      #[cfg(target_os = "android")]
      app.handle().plugin(commands::android::init())?;

      let shell = commands::build_shell(app.handle())?;
      note_launch_links(app.handle(), &shell);
      let script = shell.injection_script();
      app.manage(shell);

      // The window is built here, not from the config, so the injection runs before the UI.
      tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        .title("Forerunner")
        .initialization_script(&script)
        .build()?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::shell_info,
      commands::device_key_public,
      commands::device_key_sign,
      commands::device_key_forget,
      commands::secure_store_get,
      commands::secure_store_set,
      commands::secure_store_delete,
      commands::assert_biometric,
      commands::push_status,
    ]);
  if let Err(error) = builder.run(tauri::generate_context!()) {
    log::error!("error while running the Forerunner shell: {error}");
    std::process::exit(1);
  }
}

/// `fr://pair?...` links: the UI reads them through the deep-link plugin; the shell only
/// remembers the service URL they name so the next launch injects it.
fn note_launch_links<R: tauri::Runtime>(app: &tauri::AppHandle<R>, shell: &commands::Shell) {
  use tauri_plugin_deep_link::DeepLinkExt;
  if let Ok(Some(urls)) = app.deep_link().get_current() {
    for url in urls {
      commands::note_pairing_link(shell, url.as_str());
    }
  }
  let handle = app.clone();
  app.deep_link().on_open_url(move |event| {
    if let Some(shell) = handle.try_state::<commands::Shell>() {
      for url in event.urls() {
        commands::note_pairing_link(&shell, url.as_str());
      }
    }
  });
}
