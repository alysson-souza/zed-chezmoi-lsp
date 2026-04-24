#!/usr/bin/env node

"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { URL } = require("node:url");

const TextDocumentSyncKind = {
  None: 0,
  Full: 1,
  Incremental: 2,
};

const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
};

const CompletionItemKind = {
  Keyword: 14,
  Function: 3,
  Variable: 6,
};

const InsertTextFormat = {
  PlainText: 1,
  Snippet: 2,
};

const COMMON_SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
];

const COMMON_SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
];

function logMessage(connection, type, message) {
  connection.notify("window/logMessage", { type, message });
}

class JsonRpcPeer {
  constructor(input, output, name) {
    this.input = input;
    this.output = output;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.onRequest = async () => null;
    this.onNotification = () => {};

    input.on("data", (chunk) => this.handleData(chunk));
    input.on("error", (error) => this.failAll(error));
    input.on("close", () => this.failAll(new Error(`${name} closed`)));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd).toString("ascii");
      const match = /^Content-Length:\s*(\d+)/im.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (this.buffer.length < messageEnd) {
        return;
      }

      const body = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);

      try {
        this.handleMessage(JSON.parse(body));
      } catch (error) {
        this.sendError(null, -32700, `${this.name}: failed to parse JSON-RPC message: ${error.message}`);
      }
    }
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id") && Object.prototype.hasOwnProperty.call(message, "method")) {
      Promise.resolve()
        .then(() => this.onRequest(message.method, message.params))
        .then((result) => this.send({ jsonrpc: "2.0", id: message.id, result: result ?? null }))
        .catch((error) => this.sendError(message.id, -32603, error.message || String(error)));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      try {
        this.onNotification(message.method, message.params);
      } catch {
        // Notifications are best-effort.
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  sendError(id, code, message) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  send(message) {
    const body = JSON.stringify(message);
    const headers = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    this.output.write(headers + body);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function fileNameFromUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "file:") {
      return decodeURIComponent(parsed.pathname.split("/").pop() || "");
    }
  } catch {
    // Fall through.
  }
  return uri.split("/").pop() || uri;
}

function pathFromUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "file:") {
      return decodeURIComponent(parsed.pathname);
    }
  } catch {
    // Fall through.
  }
  return uri;
}

function hostUriForTemplateUri(uri) {
  return uri.endsWith(".tmpl") ? uri.slice(0, -".tmpl".length) : uri;
}

function stripChezmoiSourcePrefixes(fileName) {
  let normalized = fileName;
  let changed = true;

  while (changed) {
    changed = false;
    for (const prefix of [
      "private_",
      "encrypted_",
      "executable_",
      "readonly_",
      "create_",
      "modify_",
      "remove_",
    ]) {
      if (normalized.startsWith(prefix)) {
        normalized = normalized.slice(prefix.length);
        changed = true;
      }
    }
  }

  if (normalized.startsWith("dot_")) {
    normalized = `.${normalized.slice("dot_".length)}`;
  }

  return normalized;
}

function hostNameCandidates(fileName) {
  const candidates = [fileName];
  const chezmoiName = stripChezmoiSourcePrefixes(fileName);

  if (chezmoiName !== fileName) {
    candidates.push(chezmoiName);
  }

  if (chezmoiName.startsWith(".") && chezmoiName.length > 1) {
    candidates.push(chezmoiName.slice(1));
  }

  return [...new Set(candidates.map((candidate) => candidate.toLowerCase()))];
}

function normalizeHostLanguages(raw) {
  const result = {};
  if (!raw || typeof raw !== "object") {
    return result;
  }

  for (const [suffix, config] of Object.entries(raw)) {
    if (!config || typeof config !== "object") {
      continue;
    }
    const command = typeof config.command === "string" ? config.command : null;
    const languageId = typeof config.languageId === "string"
      ? config.languageId
      : typeof config.language_id === "string"
        ? config.language_id
        : suffix;

    result[suffix.toLowerCase()] = {
      languageId,
      command,
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: config.env && typeof config.env === "object" ? config.env : {},
      initializationOptions: config.initializationOptions ?? config.initialization_options,
      settings: config.settings,
    };
  }
  return result;
}

function inferHostKey(uri, hostLanguages) {
  const withoutTemplateSuffix = hostUriForTemplateUri(pathFromUri(uri));
  const normalizedPath = withoutTemplateSuffix.toLowerCase();
  const fileNames = hostNameCandidates(fileNameFromUri(withoutTemplateSuffix));

  let best = null;
  for (const suffix of Object.keys(hostLanguages || {})) {
    if (suffix === "*") {
      continue;
    }
    const normalizedSuffix = suffix.toLowerCase();
    const suffixMatches =
      normalizedPath.endsWith(`.${normalizedSuffix}`) ||
      fileNames.some((fileName) => fileName === normalizedSuffix || fileName.endsWith(`.${normalizedSuffix}`));
    if (suffixMatches && (!best || normalizedSuffix.length > best.length)) {
      best = normalizedSuffix;
    }
  }

  if (best) {
    return best;
  }

  for (const fileName of fileNames) {
    const lastDot = fileName.lastIndexOf(".");
    if (lastDot !== -1 && lastDot + 1 < fileName.length) {
      return fileName.slice(lastDot + 1);
    }
  }

  return "*";
}

function shouldSuppressHostError(error) {
  const message = error?.message || "";
  return error?.code === "ENOENT"
    || /spawn\s+.+\s+ENOENT/.test(message)
    || /No host LSP command configured/.test(message);
}

function findTemplateSpans(text) {
  const spans = [];
  let index = 0;

  while (index < text.length - 1) {
    const start = text.indexOf("{{", index);
    if (start === -1) {
      break;
    }

    const endMarker = text.indexOf("}}", start + 2);
    if (endMarker === -1) {
      spans.push({
        start,
        end: text.length,
        unclosed: true,
        content: text.slice(start + 2),
      });
      break;
    }

    const end = endMarker + 2;
    spans.push({
      start,
      end,
      unclosed: false,
      content: text.slice(start + 2, endMarker),
    });
    index = end;
  }

  return spans;
}

function maskTemplateSpans(text, spans = findTemplateSpans(text)) {
  const chars = text.split("");
  for (const span of spans) {
    for (let index = span.start; index < span.end; index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") {
        chars[index] = " ";
      }
    }
  }
  return chars.join("");
}

function lineOffsets(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function offsetAtPosition(text, position) {
  const offsets = lineOffsets(text);
  const line = Math.max(0, Math.min(position.line || 0, offsets.length - 1));
  const lineStart = offsets[line];
  const lineEnd = line + 1 < offsets.length ? offsets[line + 1] - 1 : text.length;
  return Math.max(lineStart, Math.min(lineStart + (position.character || 0), lineEnd));
}

function positionAtOffset(text, offset) {
  const offsets = lineOffsets(text);
  let low = 0;
  let high = offsets.length - 1;
  const clipped = Math.max(0, Math.min(offset, text.length));

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] <= clipped && (mid + 1 === offsets.length || offsets[mid + 1] > clipped)) {
      return { line: mid, character: clipped - offsets[mid] };
    }
    if (offsets[mid] > clipped) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return { line: 0, character: clipped };
}

function rangeOverlapsSpans(text, range, spans) {
  const start = offsetAtPosition(text, range.start);
  const end = offsetAtPosition(text, range.end);
  if (start === end) {
    return spans.some((span) => start >= span.start && start <= span.end);
  }
  return spans.some((span) => start < span.end && end > span.start);
}

function positionInsideSpan(text, position, spans) {
  const offset = offsetAtPosition(text, position);
  return spans.some((span) => offset >= span.start && offset <= span.end);
}

function normalizeActionContent(raw) {
  return raw
    .replace(/^\s*-?/, "")
    .replace(/-?\s*$/, "")
    .trim();
}

function createDiagnostic(text, startOffset, endOffset, message, severity = DiagnosticSeverity.Error) {
  return {
    range: {
      start: positionAtOffset(text, startOffset),
      end: positionAtOffset(text, endOffset),
    },
    severity,
    source: "chezmoi-template",
    message,
  };
}

function templateDiagnostics(text, spans = findTemplateSpans(text)) {
  const diagnostics = [];
  const stack = [];

  for (const span of spans) {
    if (span.unclosed) {
      diagnostics.push(createDiagnostic(text, span.start, span.end, "Unclosed Chezmoi template action"));
      continue;
    }

    const content = normalizeActionContent(span.content);
    if (content.startsWith("/*")) {
      continue;
    }

    const keyword = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(content)?.[1];
    if (["if", "range", "with", "define", "block"].includes(keyword)) {
      stack.push({ keyword, span });
    } else if (keyword === "end") {
      if (stack.length === 0) {
        diagnostics.push(createDiagnostic(text, span.start, span.end, "Unexpected template end"));
      } else {
        stack.pop();
      }
    } else if (keyword === "else" && stack.length === 0) {
      diagnostics.push(createDiagnostic(text, span.start, span.end, "Template else has no matching block"));
    }
  }

  for (const item of stack) {
    diagnostics.push(createDiagnostic(
      text,
      item.span.start,
      item.span.end,
      `Unclosed template ${item.keyword} block`,
      DiagnosticSeverity.Warning,
    ));
  }

  return diagnostics;
}

function applyContentChanges(text, changes) {
  let next = text;
  for (const change of changes || []) {
    if (typeof change.text !== "string") {
      continue;
    }
    if (!change.range) {
      next = change.text;
      continue;
    }
    const start = offsetAtPosition(next, change.range.start);
    const end = offsetAtPosition(next, change.range.end);
    next = next.slice(0, start) + change.text + next.slice(end);
  }
  return next;
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function filterAndRewriteResponse(value, doc) {
  if (Array.isArray(value)) {
    return value
      .map((item) => filterAndRewriteResponse(item, doc))
      .filter((item) => item !== undefined);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (value.uri === doc.hostUri && value.range && rangeOverlapsSpans(doc.text, value.range, doc.spans)) {
    return undefined;
  }

  if (value.targetUri === doc.hostUri && value.targetRange && rangeOverlapsSpans(doc.text, value.targetRange, doc.spans)) {
    return undefined;
  }

  if (value.range && !value.uri && rangeOverlapsSpans(doc.text, value.range, doc.spans)) {
    return undefined;
  }

  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "uri" && child === doc.hostUri) {
      next[key] = doc.uri;
      continue;
    }
    if (key === "targetUri" && child === doc.hostUri) {
      next[key] = doc.uri;
      continue;
    }
    if (key === "changes" && child && typeof child === "object" && !Array.isArray(child)) {
      const changes = {};
      for (const [uri, edits] of Object.entries(child)) {
        const rewrittenUri = uri === doc.hostUri ? doc.uri : uri;
        const rewrittenEdits = filterAndRewriteResponse(edits, doc);
        if (Array.isArray(rewrittenEdits) && rewrittenEdits.length > 0) {
          changes[rewrittenUri] = rewrittenEdits;
        }
      }
      next[key] = changes;
      continue;
    }

    const rewritten = filterAndRewriteResponse(child, doc);
    if (rewritten !== undefined) {
      next[key] = rewritten;
    }
  }
  return next;
}

function rewriteRequestParamsForHost(params, doc) {
  const cloned = cloneJson(params);
  return rewriteUris(cloned, doc.uri, doc.hostUri);
}

function rewriteUris(value, fromUri, toUri) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteUris(item, fromUri, toUri));
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if ((key === "uri" || key === "targetUri") && child === fromUri) {
        value[key] = toUri;
      } else {
        value[key] = rewriteUris(child, fromUri, toUri);
      }
    }
  }
  return value;
}

function createTemplateCompletionItems() {
  const keywords = ["if", "range", "with", "else", "end", "define", "block", "template"];
  const functions = [
    "default",
    "dict",
    "eq",
    "fromJson",
    "fromYaml",
    "includeTemplate",
    "joinPath",
    "lookPath",
    "not",
    "output",
    "promptBool",
    "promptString",
    "quote",
    "toJson",
    "toYaml",
  ];
  const variables = [".chezmoi", ".chezmoi.homeDir", ".chezmoi.os", ".chezmoi.arch", ".chezmoi.hostname"];

  return [
    {
      label: "if block",
      kind: CompletionItemKind.Keyword,
      insertText: "if ${1:pipeline} }}\n${0}\n{{ end",
      insertTextFormat: InsertTextFormat.Snippet,
    },
    {
      label: "range block",
      kind: CompletionItemKind.Keyword,
      insertText: "range ${1:pipeline} }}\n${0}\n{{ end",
      insertTextFormat: InsertTextFormat.Snippet,
    },
    ...keywords.map((label) => ({ label, kind: CompletionItemKind.Keyword })),
    ...functions.map((label) => ({ label, kind: CompletionItemKind.Function })),
    ...variables.map((label) => ({ label, kind: CompletionItemKind.Variable })),
  ];
}

function decodeSemanticTokens(data) {
  const tokens = [];
  let line = 0;
  let character = 0;

  for (let index = 0; index < data.length; index += 5) {
    line += data[index];
    character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
    tokens.push({
      line,
      character,
      length: data[index + 2],
      tokenType: data[index + 3],
      tokenModifiers: data[index + 4],
    });
  }
  return tokens;
}

function encodeSemanticTokens(tokens) {
  const data = [];
  let previousLine = 0;
  let previousCharacter = 0;

  for (const token of tokens) {
    const deltaLine = token.line - previousLine;
    const deltaStart = deltaLine === 0 ? token.character - previousCharacter : token.character;
    data.push(deltaLine, deltaStart, token.length, token.tokenType, token.tokenModifiers);
    previousLine = token.line;
    previousCharacter = token.character;
  }

  return data;
}

function remapSemanticTokens(result, doc, hostLegend) {
  if (!result || !Array.isArray(result.data) || !hostLegend) {
    return result;
  }

  const typeMap = new Map();
  for (let index = 0; index < (hostLegend.tokenTypes || []).length; index += 1) {
    const name = hostLegend.tokenTypes[index];
    const targetIndex = COMMON_SEMANTIC_TOKEN_TYPES.indexOf(name);
    typeMap.set(index, targetIndex === -1 ? COMMON_SEMANTIC_TOKEN_TYPES.indexOf("variable") : targetIndex);
  }

  const modifierMap = new Map();
  for (let index = 0; index < (hostLegend.tokenModifiers || []).length; index += 1) {
    const name = hostLegend.tokenModifiers[index];
    const targetIndex = COMMON_SEMANTIC_TOKEN_MODIFIERS.indexOf(name);
    if (targetIndex !== -1) {
      modifierMap.set(index, targetIndex);
    }
  }

  const tokens = decodeSemanticTokens(result.data)
    .filter((token) => {
      const range = {
        start: { line: token.line, character: token.character },
        end: { line: token.line, character: token.character + token.length },
      };
      return !rangeOverlapsSpans(doc.text, range, doc.spans);
    })
    .map((token) => {
      let modifiers = 0;
      for (const [source, target] of modifierMap.entries()) {
        if ((token.tokenModifiers & (1 << source)) !== 0) {
          modifiers |= 1 << target;
        }
      }
      return {
        ...token,
        tokenType: typeMap.get(token.tokenType) ?? COMMON_SEMANTIC_TOKEN_TYPES.indexOf("variable"),
        tokenModifiers: modifiers,
      };
    });

  return {
    ...result,
    data: encodeSemanticTokens(tokens),
  };
}

class TemplateDocument {
  constructor(uri, version, text, proxy) {
    this.uri = uri;
    this.version = version;
    this.text = text;
    this.proxy = proxy;
    this.hostDiagnostics = [];
    this.hostStatusDiagnostics = [];
    this.refresh();
  }

  refresh() {
    this.hostUri = hostUriForTemplateUri(this.uri);
    this.hostKey = inferHostKey(this.uri, this.proxy.hostLanguages);
    this.hostConfig = this.proxy.hostLanguages[this.hostKey] || this.proxy.hostLanguages["*"] || null;
    this.spans = findTemplateSpans(this.text);
    this.maskedText = maskTemplateSpans(this.text, this.spans);
    this.templateDiagnostics = templateDiagnostics(this.text, this.spans);
  }

  update(version, text) {
    this.version = version ?? this.version;
    this.text = text;
    this.refresh();
  }
}

class HostClient {
  constructor(proxy, key, config) {
    this.proxy = proxy;
    this.key = key;
    this.config = config;
    this.documents = new Map();
    this.hostUriToSourceUri = new Map();
    this.started = false;
    this.failed = null;
    this.startPromise = null;
    this.semanticTokensLegend = null;
  }

  async start() {
    if (this.failed) {
      throw this.failed;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (!this.config.command) {
      this.failed = new Error(`No host LSP command configured for suffix '${this.key}'`);
      throw this.failed;
    }

    this.startPromise = this.startInner();
    return this.startPromise;
  }

  async startInner() {
    const child = spawn(this.config.command, this.config.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.config.env || {}) },
    });
    this.child = child;
    child.stderr.on("data", (chunk) => {
      logMessage(this.proxy.connection, 4, `[${this.key}] ${chunk.toString("utf8").trim()}`);
    });
    child.on("error", (error) => {
      this.failed = error;
      if (this.connection) {
        this.connection.failAll(error);
      }
      this.proxy.markHostFailed(this.key, error);
    });
    child.on("exit", (code, signal) => {
      const error = new Error(`Host LSP '${this.key}' exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
      this.failed = error;
      if (this.connection) {
        this.connection.failAll(error);
      }
      this.proxy.markHostFailed(this.key, error);
    });

    this.connection = new JsonRpcPeer(child.stdout, child.stdin, `host:${this.key}`);
    this.connection.onRequest = (method, params) => this.handleHostRequest(method, params);
    this.connection.onNotification = (method, params) => this.handleHostNotification(method, params);

    const initializeResult = await this.connection.request("initialize", {
      processId: process.pid,
      rootUri: this.proxy.rootUri,
      workspaceFolders: this.proxy.workspaceFolders,
      capabilities: this.proxy.clientCapabilities,
      initializationOptions: this.config.initializationOptions ?? {},
    });

    this.semanticTokensLegend = initializeResult?.capabilities?.semanticTokensProvider?.legend ?? null;
    this.connection.notify("initialized", {});
    this.started = true;
  }

  async handleHostRequest(method) {
    if (method === "workspace/configuration") {
      return this.config.settings ? [this.config.settings] : [];
    }
    if (method === "client/registerCapability" || method === "client/unregisterCapability") {
      return null;
    }
    if (method === "workspace/workspaceFolders") {
      return this.proxy.workspaceFolders ?? null;
    }
    return null;
  }

  handleHostNotification(method, params) {
    if (method !== "textDocument/publishDiagnostics") {
      this.proxy.connection.notify(method, params);
      return;
    }

    const sourceUri = this.hostUriToSourceUri.get(params?.uri);
    const doc = sourceUri ? this.proxy.documents.get(sourceUri) : null;
    if (!doc) {
      return;
    }

    const diagnostics = (params.diagnostics || [])
      .filter((diagnostic) => diagnostic.range && !rangeOverlapsSpans(doc.text, diagnostic.range, doc.spans))
      .map((diagnostic) => ({
        ...diagnostic,
        source: diagnostic.source || `${this.key}-lsp`,
      }));
    doc.hostDiagnostics = diagnostics;
    this.proxy.publishDiagnostics(doc);
  }

  async openDocument(doc) {
    await this.start();
    if (this.documents.has(doc.uri)) {
      return;
    }
    this.documents.set(doc.uri, doc.version);
    this.hostUriToSourceUri.set(doc.hostUri, doc.uri);
    this.connection.notify("textDocument/didOpen", {
      textDocument: {
        uri: doc.hostUri,
        languageId: doc.hostConfig.languageId || doc.hostKey,
        version: doc.version,
        text: doc.maskedText,
      },
    });
  }

  async changeDocument(doc) {
    await this.openDocument(doc);
    this.documents.set(doc.uri, doc.version);
    this.connection.notify("textDocument/didChange", {
      textDocument: { uri: doc.hostUri, version: doc.version },
      contentChanges: [{ text: doc.maskedText }],
    });
  }

  closeDocument(doc) {
    if (!this.connection || !this.documents.has(doc.uri)) {
      return;
    }
    this.documents.delete(doc.uri);
    this.hostUriToSourceUri.delete(doc.hostUri);
    this.connection.notify("textDocument/didClose", {
      textDocument: { uri: doc.hostUri },
    });
  }

  notify(method, params) {
    this.connection?.notify(method, params);
  }

  request(method, params) {
    return this.connection.request(method, params);
  }
}

class ChezmoiProxy {
  constructor(connection) {
    this.connection = connection;
    this.documents = new Map();
    this.hostClients = new Map();
    this.hostLanguages = {};
    this.rootUri = null;
    this.workspaceFolders = null;
    this.clientCapabilities = {};
  }

  async handleRequest(method, params) {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "shutdown":
        return null;
      case "textDocument/completion":
      case "textDocument/hover":
      case "textDocument/definition":
      case "textDocument/declaration":
      case "textDocument/typeDefinition":
      case "textDocument/implementation":
      case "textDocument/references":
      case "textDocument/documentHighlight":
      case "textDocument/documentSymbol":
      case "textDocument/formatting":
      case "textDocument/rangeFormatting":
      case "textDocument/codeAction":
      case "textDocument/rename":
      case "textDocument/prepareRename":
        return this.forwardDocumentRequest(method, params);
      case "textDocument/semanticTokens/full":
        return this.forwardSemanticTokensRequest(method, params);
      default:
        return null;
    }
  }

  handleNotification(method, params) {
    switch (method) {
      case "initialized":
        return;
      case "exit":
        process.exit(0);
        return;
      case "textDocument/didOpen":
        this.didOpen(params);
        return;
      case "textDocument/didChange":
        this.didChange(params);
        return;
      case "textDocument/didClose":
        this.didClose(params);
        return;
      case "textDocument/didSave":
        this.forwardDocumentNotification(method, params);
        return;
      case "workspace/didChangeConfiguration":
        this.updateConfiguration(params?.settings);
        return;
      default:
        return;
    }
  }

  initialize(params) {
    this.rootUri = params?.rootUri ?? null;
    this.workspaceFolders = params?.workspaceFolders ?? null;
    this.clientCapabilities = params?.capabilities ?? {};
    this.updateConfiguration(params?.initializationOptions ?? {});

    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Full,
          save: { includeText: true },
        },
        completionProvider: {
          triggerCharacters: [".", "$", "{", " ", "|", "\"", "'", "/", "-"],
          resolveProvider: false,
        },
        hoverProvider: true,
        definitionProvider: true,
        declarationProvider: true,
        typeDefinitionProvider: true,
        implementationProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        codeActionProvider: true,
        renameProvider: { prepareProvider: true },
        semanticTokensProvider: {
          legend: {
            tokenTypes: COMMON_SEMANTIC_TOKEN_TYPES,
            tokenModifiers: COMMON_SEMANTIC_TOKEN_MODIFIERS,
          },
          full: true,
        },
      },
      serverInfo: {
        name: "chezmoi-lsp",
        version: "0.1.0",
      },
    };
  }

  updateConfiguration(settings = {}) {
    if (Object.prototype.hasOwnProperty.call(settings, "hostLanguages")
      || Object.prototype.hasOwnProperty.call(settings, "host_languages")) {
      const hostLanguages = settings.hostLanguages || settings.host_languages || {};
      this.hostLanguages = normalizeHostLanguages(hostLanguages);
    }
    for (const doc of this.documents.values()) {
      doc.refresh();
      this.publishDiagnostics(doc);
    }
  }

  didOpen(params) {
    const textDocument = params?.textDocument;
    if (!textDocument?.uri) {
      return;
    }
    const doc = new TemplateDocument(textDocument.uri, textDocument.version ?? 0, textDocument.text ?? "", this);
    this.documents.set(doc.uri, doc);
    this.publishDiagnostics(doc);
    this.ensureHostDocument(doc, true);
  }

  didChange(params) {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : null;
    if (!doc) {
      return;
    }
    doc.update(params.textDocument.version, applyContentChanges(doc.text, params.contentChanges));
    this.publishDiagnostics(doc);
    this.ensureHostDocument(doc, false);
  }

  didClose(params) {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : null;
    if (!doc) {
      return;
    }
    for (const host of this.hostClients.values()) {
      host.closeDocument(doc);
    }
    this.documents.delete(uri);
    this.connection.notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
  }

  publishDiagnostics(doc) {
    this.connection.notify("textDocument/publishDiagnostics", {
      uri: doc.uri,
      diagnostics: [
        ...(doc.templateDiagnostics || []),
        ...(doc.hostStatusDiagnostics || []),
        ...(doc.hostDiagnostics || []),
      ],
    });
  }

  markHostFailed(hostKey, error) {
    for (const doc of this.documents.values()) {
      if (doc.hostKey === hostKey) {
        if (shouldSuppressHostError(error)) {
          doc.hostDiagnostics = [];
          doc.hostStatusDiagnostics = [];
          this.publishDiagnostics(doc);
          continue;
        }
        doc.hostStatusDiagnostics = [{
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          severity: DiagnosticSeverity.Warning,
          source: "chezmoi-template",
          message: `Host LSP '${hostKey}' is unavailable: ${error.message}`,
        }];
        this.publishDiagnostics(doc);
      }
    }
  }

  hostClientForDoc(doc) {
    if (!doc.hostConfig?.command) {
      return null;
    }
    const cacheKey = `${doc.hostKey}:${doc.hostConfig.command}:${(doc.hostConfig.args || []).join("\u0000")}`;
    let client = this.hostClients.get(cacheKey);
    if (!client) {
      client = new HostClient(this, doc.hostKey, doc.hostConfig);
      this.hostClients.set(cacheKey, client);
    }
    return client;
  }

  async ensureHostDocument(doc, open) {
    const client = this.hostClientForDoc(doc);
    if (!client) {
      doc.hostDiagnostics = [];
      doc.hostStatusDiagnostics = [];
      this.publishDiagnostics(doc);
      return null;
    }

    try {
      doc.hostStatusDiagnostics = [];
      if (open) {
        await client.openDocument(doc);
      } else {
        await client.changeDocument(doc);
      }
      this.publishDiagnostics(doc);
      return client;
    } catch (error) {
      if (shouldSuppressHostError(error)) {
        doc.hostDiagnostics = [];
        doc.hostStatusDiagnostics = [];
        this.publishDiagnostics(doc);
        return null;
      }
      doc.hostStatusDiagnostics = [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        severity: DiagnosticSeverity.Warning,
        source: "chezmoi-template",
        message: `Host LSP '${doc.hostKey}' is unavailable: ${error.message}`,
      }];
      this.publishDiagnostics(doc);
      return null;
    }
  }

  async forwardDocumentRequest(method, params) {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : null;
    if (!doc) {
      return null;
    }

    if (params.position && positionInsideSpan(doc.text, params.position, doc.spans)) {
      if (method === "textDocument/completion") {
        return { isIncomplete: false, items: createTemplateCompletionItems() };
      }
      if (method === "textDocument/hover") {
        return {
          contents: {
            kind: "markdown",
            value: "Chezmoi template expression",
          },
        };
      }
      return null;
    }

    const client = await this.ensureHostDocument(doc, false);
    if (!client) {
      return method === "textDocument/completion" ? { isIncomplete: false, items: [] } : null;
    }

    const response = await client.request(method, rewriteRequestParamsForHost(params, doc));
    return filterAndRewriteResponse(response, doc) ?? null;
  }

  async forwardSemanticTokensRequest(method, params) {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : null;
    if (!doc) {
      return { data: [] };
    }
    const client = await this.ensureHostDocument(doc, false);
    if (!client) {
      return { data: [] };
    }
    const response = await client.request(method, rewriteRequestParamsForHost(params, doc));
    return remapSemanticTokens(response, doc, client.semanticTokensLegend) ?? { data: [] };
  }

  async forwardDocumentNotification(method, params) {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : null;
    if (!doc) {
      return;
    }
    const client = await this.ensureHostDocument(doc, false);
    if (client) {
      client.notify(method, rewriteRequestParamsForHost(params, doc));
    }
  }
}

function main() {
  const connection = new JsonRpcPeer(process.stdin, process.stdout, "zed");
  const proxy = new ChezmoiProxy(connection);
  connection.onRequest = (method, params) => proxy.handleRequest(method, params);
  connection.onNotification = (method, params) => proxy.handleNotification(method, params);
}

if (require.main === module) {
  main();
}

module.exports = {
  applyContentChanges,
  decodeSemanticTokens,
  encodeSemanticTokens,
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
};
