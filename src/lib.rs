use std::{env, fs};

use zed_extension_api::{
    self as zed,
    serde_json::{self, Value},
    settings::LspSettings,
    LanguageServerId, Result,
};

const JSON_NPM_PACKAGE: &str = "vscode-langservers-extracted";
const JSON_SERVER_PATH: &str =
    "node_modules/vscode-langservers-extracted/bin/vscode-json-language-server";
const SERVER_SOURCE: &str = include_str!("../server/chezmoi-lsp.js");

fn merge_json(base: &mut Value, overrides: Value) {
    match (base, overrides) {
        (Value::Object(base), Value::Object(overrides)) => {
            for (key, value) in overrides {
                match (base.get_mut(&key), value) {
                    (Some(base_value), override_value) => merge_json(base_value, override_value),
                    (None, override_value) => {
                        base.insert(key, override_value);
                    }
                }
            }
        }
        (base, override_value) => *base = override_value,
    }
}

fn local_json_server_config(language_id: &str) -> Result<Value> {
    let server_path = env::current_dir()
        .map_err(|error| format!("failed to resolve extension directory: {error}"))?
        .join(JSON_SERVER_PATH);

    if server_path.is_file() {
        Ok(serde_json::json!({
            "languageId": language_id,
            "command": zed::node_binary_path()?,
            "args": [server_path.to_string_lossy().to_string(), "--stdio"]
        }))
    } else {
        Ok(serde_json::json!({
            "languageId": language_id,
            "command": "vscode-json-language-server",
            "args": ["--stdio"]
        }))
    }
}

fn default_initialization_options() -> Result<Value> {
    let shell = serde_json::json!({
        "languageId": "shellscript",
        "command": "bash-language-server",
        "args": ["start"]
    });
    let mut host_languages = serde_json::Map::new();

    for key in [
        "bash",
        "sh",
        "zsh",
        "bashrc",
        "bash_profile",
        "bash_aliases",
        "bash_logout",
        "profile",
        "zshrc",
        "zshenv",
        "zprofile",
        "zlogin",
        "zlogout",
    ] {
        host_languages.insert(key.to_string(), shell.clone());
    }

    host_languages.insert(
        "fish".to_string(),
        serde_json::json!({
            "languageId": "fish",
            "command": "fish-lsp",
            "args": ["start"]
        }),
    );
    let python = serde_json::json!({
        "languageId": "python",
        "command": "pylsp",
        "args": []
    });
    for key in ["py", "pyi", "mpy"] {
        host_languages.insert(key.to_string(), python.clone());
    }
    host_languages.insert("json".to_string(), local_json_server_config("json")?);
    host_languages.insert("jsonc".to_string(), local_json_server_config("jsonc")?);
    host_languages.insert(
        "toml".to_string(),
        serde_json::json!({
            "languageId": "toml",
            "command": "taplo",
            "args": ["lsp", "stdio"]
        }),
    );
    host_languages.insert(
        "yaml".to_string(),
        serde_json::json!({
            "languageId": "yaml",
            "command": "yaml-language-server",
            "args": ["--stdio"]
        }),
    );
    host_languages.insert(
        "yml".to_string(),
        serde_json::json!({
            "languageId": "yaml",
            "command": "yaml-language-server",
            "args": ["--stdio"]
        }),
    );

    Ok(serde_json::json!({ "hostLanguages": host_languages }))
}

struct ChezmoiExtension {
    did_check_json_server: bool,
}

impl ChezmoiExtension {
    fn json_server_exists(&self) -> bool {
        fs::metadata(JSON_SERVER_PATH)
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
    }

    fn ensure_json_server(&mut self, language_server_id: &LanguageServerId) {
        if self.did_check_json_server && self.json_server_exists() {
            return;
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let Ok(latest_version) = zed::npm_package_latest_version(JSON_NPM_PACKAGE) else {
            self.did_check_json_server = true;
            return;
        };

        let installed_version = zed::npm_package_installed_version(JSON_NPM_PACKAGE)
            .ok()
            .flatten();
        let needs_install =
            !self.json_server_exists() || installed_version.as_ref() != Some(&latest_version);

        if needs_install {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            let _ = zed::npm_install_package(JSON_NPM_PACKAGE, &latest_version);
        }

        self.did_check_json_server = true;
    }
}

impl zed::Extension for ChezmoiExtension {
    fn new() -> Self {
        Self {
            did_check_json_server: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        self.ensure_json_server(language_server_id);

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec!["--eval".to_string(), format!("{SERVER_SOURCE}\nmain();")],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<Value>> {
        let mut options = default_initialization_options()?;

        if let Some(user_options) =
            LspSettings::for_worktree(language_server_id.as_ref(), worktree)?.initialization_options
        {
            merge_json(&mut options, user_options);
        }

        Ok(Some(options))
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<Value>> {
        Ok(LspSettings::for_worktree(language_server_id.as_ref(), worktree)?.settings)
    }
}

zed::register_extension!(ChezmoiExtension);
