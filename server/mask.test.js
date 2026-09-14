"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  applyContentChanges,
  filterAndRewriteResponse,
  findTemplateSpans,
  hostUriForTemplateUri,
  inferHostKey,
  maskTemplateSpans,
  normalizeHostLanguages,
  offsetAtPosition,
  positionAtOffset,
  rangeOverlapsSpans,
  shouldSuppressHostError,
  templateDiagnostics,
  positionInsideSpan: positionInsideSpanExport,
  controlActionLines,
} = require("./chezmoi-lsp");

function configPath(...parts) {
  return path.join(__dirname, "..", ...parts);
}

function readPathSuffixes(configFile) {
  const config = fs.readFileSync(configFile, "utf8");
  const match = config.match(/path_suffixes\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(match, `${configFile} should define path_suffixes`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("findTemplateSpans finds closed and unclosed template actions", () => {
  const text = "a {{ .chezmoi.os }} b {{ if .x }}";
  const spans = findTemplateSpans(text);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((span) => [span.start, span.end, span.unclosed]), [
    [2, 19, false],
    [22, 33, false],
  ]);

  const unclosed = findTemplateSpans("a {{ .x");
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0].unclosed, true);
});

test("maskTemplateSpans keeps offsets and newlines stable", () => {
  const text = "{\n  \"os\": \"{{ .chezmoi.os }}\",\n  \"name\": \"aly\"\n}\n";
  const masked = maskTemplateSpans(text);
  assert.equal(masked.length, text.length);
  assert.equal(masked.split("\n").length, text.split("\n").length);
  assert.equal(masked.includes(".chezmoi"), false);
  assert.equal(masked.slice(0, 11), text.slice(0, 11));
});

test("inferHostKey strips only the final tmpl suffix and chooses longest configured suffix", () => {
  const hostLanguages = normalizeHostLanguages({
    fish: { languageId: "fish", command: "fish-lsp", args: ["start"] },
    json: { languageId: "json", command: "json-lsp" },
    "long.name": { languageId: "plaintext", command: "example-lsp" },
    name: { languageId: "plaintext", command: "example-lsp" },
    zshrc: { languageId: "shellscript", command: "bash-language-server", args: ["start"] },
  });

  assert.equal(inferHostKey("file:///dot_config/fish/config.fish.tmpl", hostLanguages), "fish");
  assert.equal(inferHostKey("file:///tmp/a.json.tmpl", hostLanguages), "json");
  assert.equal(inferHostKey("file:///tmp/settings.json.tmpl", hostLanguages), "json");
  assert.equal(inferHostKey("file:///tmp/example.long.name.tmpl", hostLanguages), "long.name");
  assert.equal(inferHostKey("file:///dot_zshrc.tmpl", hostLanguages), "zshrc");
  assert.equal(inferHostKey("file:///private_dot_zshrc.tmpl", hostLanguages), "zshrc");
  assert.equal(inferHostKey("file:///tmp/README.tmpl", hostLanguages), "*");
});

test("JSON and JSONC templates use separate wrappers", () => {
  const jsonSuffixes = readPathSuffixes(configPath("languages", "chezmoi-template-json", "config.toml"));
  const jsoncSuffixes = readPathSuffixes(configPath("languages", "chezmoi-template-jsonc", "config.toml"));

  assert.deepEqual(jsonSuffixes, ["json.tmpl"]);
  assert.deepEqual(jsoncSuffixes, ["jsonc.tmpl"]);
});

test("proxy does not advertise semantic tokens", () => {
  const server = fs.readFileSync(configPath("server", "chezmoi-lsp.js"), "utf8");

  assert.equal(server.includes("semanticTokensProvider"), false);
  assert.equal(server.includes("textDocument/semanticTokens/full"), false);
});

test("hostUriForTemplateUri removes final .tmpl suffix", () => {
  assert.equal(hostUriForTemplateUri("file:///tmp/a.json.tmpl"), "file:///tmp/a.json");
  assert.equal(hostUriForTemplateUri("file:///tmp/a.json"), "file:///tmp/a.json");
});

test("position and offset helpers round-trip", () => {
  const text = "one\ntwo\nthree";
  const position = { line: 2, character: 2 };
  const offset = offsetAtPosition(text, position);
  assert.equal(offset, text.indexOf("r"));
  assert.deepEqual(positionAtOffset(text, offset), position);
});

test("rangeOverlapsSpans detects normal and empty ranges", () => {
  const text = "abc {{ .x }} def";
  const spans = findTemplateSpans(text);
  assert.equal(rangeOverlapsSpans(text, {
    start: { line: 0, character: 4 },
    end: { line: 0, character: 6 },
  }, spans), true);
  assert.equal(rangeOverlapsSpans(text, {
    start: { line: 0, character: 1 },
    end: { line: 0, character: 2 },
  }, spans), false);
  assert.equal(rangeOverlapsSpans(text, {
    start: { line: 0, character: 5 },
    end: { line: 0, character: 5 },
  }, spans), true);
});

test("applyContentChanges supports full and incremental changes", () => {
  assert.equal(applyContentChanges("abc", [{ text: "xyz" }]), "xyz");
  assert.equal(applyContentChanges("abc", [{
    range: {
      start: { line: 0, character: 1 },
      end: { line: 0, character: 2 },
    },
    text: "B",
  }]), "aBc");
});

test("templateDiagnostics reports unclosed blocks and unexpected ends", () => {
  const openDiagnostics = templateDiagnostics("{{ if .x }}\nvalue\n");
  assert.equal(openDiagnostics.length, 1);
  assert.match(openDiagnostics[0].message, /Unclosed template if block/);

  const endDiagnostics = templateDiagnostics("{{ end }}");
  assert.equal(endDiagnostics.length, 1);
  assert.match(endDiagnostics[0].message, /Unexpected template end/);
});

test("filterAndRewriteResponse drops host ranges that overlap template spans", () => {
  const doc = {
    uri: "file:///tmp/a.json.tmpl",
    hostUri: "file:///tmp/a.json",
    text: "{\"value\":\"{{ .x }}\", \"name\": \"ok\"}",
    spans: findTemplateSpans("{\"value\":\"{{ .x }}\", \"name\": \"ok\"}"),
  };

  const response = [
    {
      uri: doc.hostUri,
      range: {
        start: { line: 0, character: 10 },
        end: { line: 0, character: 14 },
      },
    },
    {
      uri: doc.hostUri,
      range: {
        start: { line: 0, character: 28 },
        end: { line: 0, character: 32 },
      },
    },
  ];

  assert.deepEqual(filterAndRewriteResponse(response, doc), [
    {
      uri: doc.uri,
      range: {
        start: { line: 0, character: 28 },
        end: { line: 0, character: 32 },
      },
    },
  ]);
});

test("shouldSuppressHostError hides missing optional host servers", () => {
  assert.equal(shouldSuppressHostError(Object.assign(new Error("spawn taplo ENOENT"), { code: "ENOENT" })), true);
  assert.equal(shouldSuppressHostError(new Error("spawn taplo ENOENT")), true);
  assert.equal(shouldSuppressHostError(new Error("No host LSP command configured for suffix 'conf'")), true);
  assert.equal(shouldSuppressHostError(new Error("Host LSP 'toml' exited with code 1 signal null")), false);
});

test("inferHostKey prefers a shebang over the target file name", () => {
  const hostLanguages = normalizeHostLanguages({
    fish: { languageId: "fish", command: "fish-lsp", args: ["start"] },
    json: { languageId: "json", command: "vscode-json-language-server" },
    py: { languageId: "python", command: "pylsp" },
    sh: { languageId: "shellscript", command: "bash-language-server" },
  });

  assert.equal(inferHostKey("file:///s/modify_private_settings.json.tmpl", hostLanguages, "#!/usr/bin/env fish\nset -l x 1\n"), "fish");
  assert.equal(inferHostKey("file:///s/modify_private_config.toml.tmpl", hostLanguages, "#!/usr/bin/env python3\n"), "py");
  assert.equal(inferHostKey("file:///s/run_once_install.tmpl", hostLanguages, "#!/bin/bash\n"), "sh");
  assert.equal(inferHostKey("file:///s/config.fish.tmpl", hostLanguages, "# no shebang\n"), "fish");
  assert.equal(inferHostKey("file:///s/settings.json.tmpl", hostLanguages, "{\n  \"a\": \"{{ .x }}\"\n}\n"), "json");
});

test("maskTemplateSpans fills bare value actions with a host placeholder", () => {
  const text = "{\n  \"a\": {{ .x }},\n  \"b\": \"{{ .y }}\",\n{{ if .z }}\n  \"c\": {{- .w -}}\n{{ end }}\n}\n";
  const masked = maskTemplateSpans(text, findTemplateSpans(text), { valueFiller: "null" });

  assert.equal(masked.length, text.length);
  assert.equal(masked.split("\n").length, text.split("\n").length);
  const lines = masked.split("\n");
  assert.equal(lines[1], "  \"a\": null    ,");
  assert.equal(lines[2], "  \"b\": \"        \",");
  assert.equal(lines[3], "           ");
  assert.equal(lines[4], "  \"c\": null      ");
  assert.equal(lines[5], "         ");
  assert.equal(maskTemplateSpans(text), maskTemplateSpans(text, findTemplateSpans(text), {}));
});

test("maskTemplateSpans keeps a filler that does not fit as spaces", () => {
  const text = "a: {{.x}}\n";
  assert.equal(maskTemplateSpans(text, findTemplateSpans(text), { valueFiller: "nullish" }), "a:       \n");
});

test("maskTemplateSpans never fills actions that print nothing", () => {
  const text = "{{- $cfg := .mcp -}}\n{{- $n = 1 -}}\n{{- /* note */ -}}\n{{ template \"x\" . }}\n{ \"a\": {{ $cfg.url | quote }} }\n";
  const masked = maskTemplateSpans(text, findTemplateSpans(text), { valueFiller: "null" });
  const lines = masked.split("\n");
  assert.equal(lines[0].trim(), "");
  assert.equal(lines[1].trim(), "");
  assert.equal(lines[2].trim(), "");
  assert.equal(lines[3].trim(), "");
  assert.equal(lines[4], "{ \"a\": null                   }");
});

test("maskTemplateSpans uses an empty quoted key for actions in key position", () => {
  const text = "{\n  {{ $name }}: { \"v\": {{ .v }} },\n  \"{{ .k }}\": 1\n}\n";
  const masked = maskTemplateSpans(text, findTemplateSpans(text), { valueFiller: "null" });
  assert.equal(masked.split("\n")[1], "  \"\"         : { \"v\": null     },");
  assert.equal(masked.split("\n")[2], "  \"        \": 1");
  assert.doesNotThrow(() => JSON.parse(masked));
  assert.equal(maskTemplateSpans("{{ $k }} = 1\n", undefined, { valueFiller: "\"\"" }), "\"\"       = 1\n");
});

test("findTemplateSpans ignores `}}` inside strings, raw strings and comments", () => {
  const cases = [
    ["a {{ \"}}\" }} b", 2, 12],
    ["a {{ printf \"x }} y\" }} b", 2, 23],
    ["a {{ printf `x }} y` }} b", 2, 23],
    ["a {{/* see }} here */}} b", 2, 23],
    ["a {{- /* }} */ -}} b", 2, 18],
    ["a {{ 'q}}' }} b", 2, 13],
  ];
  for (const [text, start, end] of cases) {
    const spans = findTemplateSpans(text);
    assert.deepEqual(spans.map((span) => [span.start, span.end, span.unclosed]), [[start, end, false]], text);
    assert.equal(maskTemplateSpans(text).includes("}}"), false, text);
  }
  const unclosed = findTemplateSpans("a {{ \"}}\" ");
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0].unclosed, true);
});

test("positions right before `{{` and right after `}}` belong to the host", () => {
  const text = "foo{{ .bar }}baz";
  const spans = findTemplateSpans(text);
  assert.equal(positionInsideSpanExport(text, { line: 0, character: 3 }, spans), false);
  assert.equal(positionInsideSpanExport(text, { line: 0, character: 4 }, spans), true);
  assert.equal(positionInsideSpanExport(text, { line: 0, character: 12 }, spans), true);
  assert.equal(positionInsideSpanExport(text, { line: 0, character: 13 }, spans), false);
  assert.equal(rangeOverlapsSpans(text, { start: { line: 0, character: 13 }, end: { line: 0, character: 13 } }, spans), false);
  assert.equal(rangeOverlapsSpans(text, { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, spans), false);
});

test("filterAndRewriteResponse keeps symbols that merely enclose a template action", () => {
  const text = "function foo\n    {{ if .x }}\n    echo hi\n    {{ end }}\nend\n";
  const doc = { uri: "file:///r/a.fish.tmpl", hostUri: "file:///r/a.fish", text, spans: findTemplateSpans(text) };
  const hierarchical = [{
    name: "foo", kind: 12,
    range: { start: { line: 0, character: 0 }, end: { line: 4, character: 3 } },
    selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
    children: [{
      name: "ghost", kind: 13,
      range: { start: { line: 1, character: 4 }, end: { line: 1, character: 15 } },
      selectionRange: { start: { line: 1, character: 7 }, end: { line: 1, character: 9 } },
    }],
  }];
  const result = filterAndRewriteResponse(hierarchical, doc);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "foo");
  assert.deepEqual(result[0].range, hierarchical[0].range);
  assert.equal(result[0].children.length, 0);

  const flat = [{ name: "foo", kind: 12, location: { uri: doc.hostUri, range: hierarchical[0].range } }];
  assert.deepEqual(filterAndRewriteResponse(flat, doc), [{ name: "foo", kind: 12, location: { uri: doc.uri, range: hierarchical[0].range } }]);
});

test("filterAndRewriteResponse leaves other files' edits alone in workspace edits", () => {
  const text = "{{ .os }} set -x FOO bar\nfunction greet\nend\n";
  const doc = { uri: "file:///r/config.fish.tmpl", hostUri: "file:///r/config.fish", text, spans: findTemplateSpans(text) };
  const edit = (line, a, b) => ({ range: { start: { line, character: a }, end: { line, character: b } }, newText: "x" });
  const response = {
    changes: {
      "file:///r/config.fish": [edit(0, 2, 5), edit(1, 9, 14)],
      "file:///r/other.fish": [edit(0, 0, 5)],
    },
    documentChanges: [
      { textDocument: { uri: "file:///r/other.fish", version: 1 }, edits: [edit(0, 0, 5)] },
      { textDocument: { uri: "file:///r/config.fish", version: 1 }, edits: [edit(0, 2, 5), edit(1, 9, 14)] },
    ],
  };
  const result = filterAndRewriteResponse(response, doc);
  assert.deepEqual(Object.keys(result.changes).sort(), ["file:///r/config.fish.tmpl", "file:///r/other.fish"]);
  assert.equal(result.changes["file:///r/config.fish.tmpl"].length, 1);
  assert.equal(result.changes["file:///r/other.fish"].length, 1);
  assert.equal(result.documentChanges[0].edits.length, 1);
  assert.equal(result.documentChanges[1].textDocument.uri, doc.uri);
  assert.equal(result.documentChanges[1].edits.length, 1);
});

test("inferHostKey sees a shebang below leading template declarations", () => {
  const hostLanguages = normalizeHostLanguages({
    fish: { languageId: "fish", command: "fish-lsp", args: ["start"] },
    json: { languageId: "json", command: "vscode-json-language-server" },
  });
  const text = "{{- $mcp := .mcp -}}\n{{- $kagi := printf \"%s\" $mcp.vault -}}\n\n#!/usr/bin/env fish\nset -l x 1\n";
  assert.equal(inferHostKey("file:///s/modify_private_config.json.tmpl", hostLanguages, text), "fish");
  assert.equal(inferHostKey("file:///s/config.json.tmpl", hostLanguages, "{{- $x := 1 -}}\n{ \"a\": 1 }\n"), "json");
});

test("controlActionLines covers lines with control actions but not value actions", () => {
  const text = "{\n  \"a\": {{ .x }},\n{{- range $i, $m := .list }}{{ if $i }},{{ end }}\n  \"b\": 1\n{{ end }}\n}\n";
  assert.deepEqual([...controlActionLines(text)].sort(), [2, 4]);
});

test("inferHostKey strips every chezmoi source attribute prefix", () => {
  const hostLanguages = normalizeHostLanguages({
    fish: { languageId: "fish", command: "fish-lsp" },
    toml: { languageId: "toml", command: "taplo" },
    zshrc: { languageId: "shellscript", command: "bash-language-server" },
  });
  assert.equal(inferHostKey("file:///s/.chezmoiscripts/run_onchange_after_12-setup.fish.tmpl", hostLanguages), "fish");
  assert.equal(inferHostKey("file:///s/run_once_before_00-clean.fish.tmpl", hostLanguages), "fish");
  assert.equal(inferHostKey("file:///s/exact_dot_config/symlink_dot_zshrc.tmpl", hostLanguages), "zshrc");
  assert.equal(inferHostKey("file:///s/literal_run_notes.toml.tmpl", hostLanguages), "toml");
  assert.equal(inferHostKey("file:///s/.chezmoiexternal.toml.tmpl", hostLanguages), "toml");
});

test("a script whose interpreter has no host is not routed by file name", () => {
  const hostLanguages = normalizeHostLanguages({ json: { languageId: "json", command: "vscode-json-language-server" } });
  assert.equal(inferHostKey("file:///s/modify_settings.json.tmpl", hostLanguages, "#!/usr/bin/env bash\n"), "bash");
});
