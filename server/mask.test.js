"use strict";

const assert = require("node:assert/strict");
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
  remapSemanticTokens,
  shouldSuppressHostError,
  templateDiagnostics,
} = require("./chezmoi-lsp");

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
  assert.equal(inferHostKey("file:///tmp/settings.json.tmpl", hostLanguages), "json");
  assert.equal(inferHostKey("file:///tmp/example.long.name.tmpl", hostLanguages), "long.name");
  assert.equal(inferHostKey("file:///dot_zshrc.tmpl", hostLanguages), "zshrc");
  assert.equal(inferHostKey("file:///private_dot_zshrc.tmpl", hostLanguages), "zshrc");
  assert.equal(inferHostKey("file:///tmp/README.tmpl", hostLanguages), "*");
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

test("remapSemanticTokens drops tokens inside template spans", () => {
  const text = "a {{ .x }} b";
  const doc = {
    text,
    spans: findTemplateSpans(text),
  };
  const hostLegend = {
    tokenTypes: ["keyword", "variable"],
    tokenModifiers: ["declaration"],
  };
  const result = remapSemanticTokens({
    data: [
      0, 0, 1, 0, 0,
      0, 3, 2, 1, 0,
      0, 9, 1, 1, 0,
    ],
  }, doc, hostLegend);

  assert.deepEqual(result.data, [
    0, 0, 1, 15, 0,
    0, 12, 1, 8, 0,
  ]);
});

test("shouldSuppressHostError hides missing optional host servers", () => {
  assert.equal(shouldSuppressHostError(Object.assign(new Error("spawn taplo ENOENT"), { code: "ENOENT" })), true);
  assert.equal(shouldSuppressHostError(new Error("spawn taplo ENOENT")), true);
  assert.equal(shouldSuppressHostError(new Error("No host LSP command configured for suffix 'conf'")), true);
  assert.equal(shouldSuppressHostError(new Error("Host LSP 'toml' exited with code 1 signal null")), false);
});
