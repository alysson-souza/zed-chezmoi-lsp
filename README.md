# Zed Chezmoi Templates

Chezmoi template support for [Zed](https://zed.dev/).

This extension highlights Chezmoi template actions inside text-based dotfiles
and configuration files while preserving host-language syntax where possible.

## Features

- Treats `*.tmpl` files as Chezmoi templates
- Treats `.chezmoiignore` as a Chezmoi template
- Preserves host-language syntax highlighting for common file types
- Proxies non-template regions to host language servers when configured
- Filters host diagnostics that overlap `{{ ... }}` regions
- Uses tree-sitter injections for syntax colors instead of host LSP semantic tokens
- Falls back to plain Chezmoi template highlighting for unknown suffixes

## Supported Host Syntax Wrappers

The extension ships static tree-sitter wrappers for these common template
suffixes:

- `*.ini.tmpl`
- `*.json.tmpl`
- `*.jsonc.tmpl`
- `*.fish.tmpl`
- `*.py.tmpl`, `*.pyi.tmpl`, `*.mpy.tmpl`
- `*.sh.tmpl`, `*.bash.tmpl`, `*.zsh.tmpl`
- `*.yaml.tmpl`, `*.yml.tmpl`
- `*.toml.tmpl`

It also includes shell-oriented dotfile cases such as `dot_zshrc.tmpl`,
`dot_zshenv.tmpl`, `dot_bashrc.tmpl`, and `dot_profile.tmpl`.

Examples:

- `config.fish.tmpl`
- `settings.json.tmpl`
- `settings.jsonc.tmpl`
- `script.py.tmpl`
- `config.toml.tmpl`
- `app.ini.tmpl`

## How It Works

Zed syntax highlighting is tree-sitter based, so host-language highlighting must
be declared through static wrapper languages. This extension uses the Go-template
grammar for Chezmoi syntax, then injects surrounding plain text into the host
language for supported suffixes.

For editor features beyond syntax highlighting, the extension can proxy
non-template regions to a host language server chosen from the filename after
removing the final `.tmpl` suffix.

If a host language server is unavailable, the extension still provides Chezmoi
highlighting and any available host tree-sitter syntax highlighting.

## Configuration

Host language servers can be customized through Zed LSP initialization options:

```json
{
  "lsp": {
    "chezmoi-lsp": {
      "initialization_options": {
        "hostLanguages": {
          "fish": {
            "languageId": "fish",
            "command": "fish-lsp",
            "args": ["start"]
          },
          "py": {
            "languageId": "python",
            "command": "pylsp",
            "args": []
          }
        }
      }
    }
  }
}
```

The extension includes starter mappings for common host languages. Additional
suffixes can be added through `hostLanguages`, but syntax highlighting for a new
host syntax still requires a matching wrapper language because Zed injections
are static.

## `.chezmoitemplates`

Zed's extension matcher cannot claim an entire directory tree such as
`.chezmoitemplates/**` on its own. If your chezmoi source directory contains
real filenames inside `.chezmoitemplates`, add a project-level file association
in `.zed/settings.json`:

```json
{
  "file_types": {
    "Chezmoi Template": [
      "**/.chezmoitemplates/**"
    ]
  }
}
```

That makes every file under `.chezmoitemplates` open as a Chezmoi template
without changing how those file types behave in unrelated projects.

## Development

```sh
cargo check --target wasm32-wasip2
npm test
```

To load the extension in Zed, open the Extensions view and use
`Install Dev Extension`, then select the repository directory.
