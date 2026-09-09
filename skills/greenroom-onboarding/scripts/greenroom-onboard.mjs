#!/usr/bin/env node
// Greenroom onboarding helper for a customer's coding agent (skills/greenroom-onboarding).
//
//   node greenroom-onboard.mjs detect [DIR] [--json]
//   node greenroom-onboard.mjs pin [--platform web|ios] [--docs-url URL]
//   node greenroom-onboard.mjs draft [DIR] --out OUTDIR --app SLUG [options]
//   node greenroom-onboard.mjs check DIR [--pin SHA] [--json]
//
// Zero dependencies: node:fs, node:path and the global fetch only. It never
// runs a version-control command or any other process, never reads a secret
// value (it accepts secret NAMES only), never writes outside --out, and never
// uploads anything. Its only network use is reading the public docs for the
// current stable workflow pin, and that is skipped when --pin is given.
//
// Inside the Greenroom repository (this file at skills/greenroom-onboarding/
// scripts/) it reuses packages/production/src/setup.js for the stable pin and
// the reference templates, and scripts/lib/setup-preflight.mjs for the check.
// Standalone, in a customer repository, it uses the vendored equivalents
// below; packages/production/test/onboarding-skill.test.js proves the
// vendored output is byte-identical to the generator's on the plain case.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const DOCS_ORIGIN = "https://docs.getgreenroom.io";
const WORKFLOW_PATH = "justindc100/greenroom-action/.github/workflows/pass.yml";
const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FILES = { workflow: ".github/workflows/greenroom.yml", environment: ".greenroom/environment.json", contract: ".greenroom/state-contract.json" };
const WEB_PREVIEW_URL = "http://127.0.0.1:4173/";
const IGNORED_DIRS = new Set([".git", "node_modules", "Pods", "build", "dist", ".next", ".vercel", ".claude", ".codex", ".cursor", ".idea", ".vscode", "coverage", "android", "DerivedData", ".expo", "vendor", ".greenroom-draft", "__pycache__", ".build", "web-build"]);
// Directories that are not the app the walk exercises (a co-located backend,
// docs, design files, CI helpers): hosts found there are not the app's.
const NOT_THE_APP = /^(server|backend|api|docs?|design|marketing|fastlane|e2e|__mocks__|tests?|scripts|infra|terraform|\.github|\.greenroom)\//;
// Files whose contents may hold secrets are never read; only *.example and
// *.sample dotenv files are.
const SECRET_FILE = /(^|\/)\.env(\.[^/]*)?$|(^|\/)(secrets?|credentials?)\.(json|ya?ml)$|\.(pem|p12|key|keystore|jks|mobileprovision)$/;
const DOTENV_EXAMPLE = /(^|\/)\.env(\.[^/]*)?\.(example|sample)$/;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|swift|m|mm|json|plist|html|css|yml|yaml|py|sh|rb|txt|template)$/;

// ---------------------------------------------------------------- utilities
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const uniq = (values) => [...new Set(values)];
const posix = (value) => value.split(path.sep).join("/");
const exists = (file) => { try { fs.accessSync(file); return true; } catch { return false; } };
const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const readJson = (file) => { const text = readText(file); if (text === null) return null; try { return JSON.parse(text); } catch { return null; } };
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseArgs(argv) {
  const values = {}; const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s);
      if (inline !== undefined) values[key] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) values[key] = argv[++i];
      else values[key] = true;
    } else positional.push(arg);
  }
  return { values, positional };
}

// Every file under a working tree, repository-relative with forward slashes.
// Version-control metadata, node_modules, Pods and build products are never sources.
function walk(directory, { extensions = null, limit = 40000 } = {}) {
  const out = [];
  const visit = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full);
      else {
        const relative = posix(path.relative(directory, full));
        if (SECRET_FILE.test(relative) && !DOTENV_EXAMPLE.test(relative)) continue;
        if (!extensions || extensions.test(entry.name)) out.push(relative);
      }
    }
  };
  visit(directory);
  return out;
}

// Same glob rules as packages/production/src/source-globs.js (vendored: `*`
// within a segment, `**` across segments, `?` one character, trailing `/`
// means everything under the directory).
function globToRegExp(glob) {
  let pattern = String(glob ?? "").trim().replace(/^(?:\.\/)+/, "");
  if (pattern.endsWith("/")) pattern += "**";
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") { index += 1; if (pattern[index + 1] === "/") { index += 1; source += "(?:.*/)?"; } else source += ".*"; }
      else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`);
}
const matchesGlob = (file, glob) => globToRegExp(glob).test(String(file).replace(/^(?:\.\/)+/, ""));

// ------------------------------------------------- reuse inside the Greenroom repo
let repoModules = null;
async function loadRepoModules() {
  if (repoModules !== null) return repoModules || null;
  repoModules = false;
  if (process.env.GREENROOM_ONBOARD_STANDALONE === "1") return null;
  const setup = path.join(REPO_ROOT, "packages/production/src/setup.js");
  const preflight = path.join(REPO_ROOT, "scripts/lib/setup-preflight.mjs");
  if (!exists(setup) || !exists(preflight)) return null;
  try {
    const [setupModule, preflightModule] = await Promise.all([import(pathToFileURL(setup).href), import(pathToFileURL(preflight).href)]);
    repoModules = { ...setupModule, ...preflightModule };
    return repoModules;
  } catch { return null; }
}

// ------------------------------------------------------------------- pin
export async function fetchStablePin({ platform = "web", docsUrl = null } = {}) {
  const url = docsUrl ?? `${DOCS_ORIGIN}/docs/quickstart/${platform === "ios" ? "ios" : "web"}`;
  const response = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const text = await response.text();
  const pins = uniq([...text.matchAll(/pass\.yml@([a-f0-9]{40})/g)].map((match) => match[1]));
  if (pins.length !== 1) throw new Error(pins.length ? `${url} quotes more than one pin (${pins.join(", ")}); ask the user which is stable` : `${url} quotes no pass.yml pin; ask the user for the current stable pin from the quickstart`);
  return { sha: pins[0], uses: `${WORKFLOW_PATH}@${pins[0]}`, source: url };
}

// Which runner release a pin is. Inside the Greenroom repository the trust
// list says (its note names the runner version); a customer's copy has only
// the docs page, which quotes the SHA alone, so it says so instead of guessing.
export async function releaseNameOf(sha) {
  const trust = process.env.GREENROOM_ONBOARD_STANDALONE === "1" ? null : readJson(path.join(REPO_ROOT, "packages/production/config/trusted-workflows.json"));
  const entry = trust?.workflows?.find((item) => item.sha === sha);
  if (entry) return `${entry.note ?? "(no note)"} [status ${entry.status}, since ${entry.since}]`;
  return "the docs page quotes the commit SHA only; the SHA is the identity Greenroom trusts, so quote it (not a version number) in your setup record";
}

async function resolvePin(values, platform) {
  if (values.pin) {
    const sha = String(values.pin).replace(/^.*@/, "");
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("--pin must be the 40-character commit SHA of Greenroom's reusable workflow (or the full uses: value)");
    return { sha, uses: `${WORKFLOW_PATH}@${sha}`, source: "--pin" };
  }
  const repo = await loadRepoModules();
  if (repo?.PASS_WORKFLOW_USES) { const [, sha] = repo.PASS_WORKFLOW_USES.split("@"); return { sha, uses: repo.PASS_WORKFLOW_USES, source: "packages/production/src/setup.js (stable trusted workflow)" }; }
  if (values.offline) return null;
  return fetchStablePin({ platform, docsUrl: values["docs-url"] ?? null });
}

// ------------------------------------------------------------- detection
const KNOWN_SDK_HOSTS = [
  { dependency: /^react-native-purchases$|^@revenuecat\//, hosts: ["api.revenuecat.com"], note: "RevenueCat native SDK; not covered by any JS fetch patch" },
  { dependency: /^posthog-(react-native|js|node)$/, hosts: ["us.i.posthog.com"], note: "PostHog (us.i.posthog.com by default; eu.i.posthog.com for EU projects; check POSTHOG_HOST)" },
  { dependency: /^@sentry\//, hosts: ["ingest.sentry.io"], note: "Sentry ingest host is o<org>.ingest.<region>.sentry.io from the DSN. A test build compiled without a DSN sends nothing: list no Sentry host at all. Only when the test build carries a DSN, list its exact host (the DSN is a public value the app ships with; never read it from .env)" },
  { dependency: /^react-native-fbsdk-next$|^react-native-fbsdk$/, hosts: ["graph.facebook.com"], note: "Meta SDK attribution and events" },
  { dependency: /^@react-native-google-signin\//, hosts: ["accounts.google.com", "oauth2.googleapis.com"], note: "Google Sign-In (a sign-in journey, out of the session-import contract)" },
  { dependency: /^expo-apple-authentication$/, hosts: ["appleid.apple.com"], note: "Sign in with Apple (a sign-in journey, out of the session-import contract)" },
  { dependency: /^firebase$|^@react-native-firebase\//, hosts: ["firestore.googleapis.com", "firebaseinstallations.googleapis.com"], note: "Firebase; list the products the build uses" },
  { dependency: /^@amplitude\//, hosts: ["api2.amplitude.com"], note: "Amplitude analytics" },
  { dependency: /^mixpanel/, hosts: ["api.mixpanel.com"], note: "Mixpanel analytics" },
  { dependency: /^@segment\//, hosts: ["api.segment.io", "cdn-settings.segment.com"], note: "Segment analytics" },
  { dependency: /^@stripe\//, hosts: ["api.stripe.com"], note: "Stripe" },
  { dependency: /^@supabase\//, hosts: ["<project>.supabase.co"], note: "Supabase; the project host is in the client config" },
  { dependency: /^expo-updates$/, hosts: ["u.expo.dev"], note: "EAS Update; disable updates in the test build or list the host" },
];
const LINK_ONLY_HOSTS = /^(docs\.|www\.)?(apps\.apple\.com|nextjs\.org|registry\.npmjs\.org|unpkg\.com|cdnjs\.cloudflare\.com|your-domain\.com|openapi\.vercel\.sh|react\.doctor|reactnavigation\.org|schemastore\.org|json\.schemastore\.org|play\.google\.com|docs\.expo\.dev|developer\.apple\.com|github\.com|x\.com|twitter\.com|instagram\.com|facebook\.com|linkedin\.com|tiktok\.com|youtube\.com|youtu\.be|reactnative\.dev|reactjs\.org|react\.dev|expo\.dev|nodejs\.org|npmjs\.com|pubmed\.ncbi\.nlm\.nih\.gov|cdc\.gov|who\.int|wikipedia\.org|en\.wikipedia\.org|json-schema\.org|www\.w3\.org|w3\.org|schema\.org|sentry\.io|revenuecat\.com|posthog\.com|auth\.expo\.io|example\.com|example\.org|example\.test|localhost)$/i;
const IMPORT_PATH_PATTERNS = [
  { code: "greenroom-session-file", pattern: /greenroom-session(?:\.json)?|GREENROOM_SESSION_FILE|install-session/i, why: "a session file written into the app container for the app to import" },
  { code: "in-app-session-importer", pattern: /importGreenroomSession|SessionBootstrap|GREENROOM_QA|greenroomSession|importSession\s*\(|injectSession|seedSession/, why: "an in-app importer compiled into a test build" },
  { code: "keychain-writer-in-repo", pattern: /SecItemAdd|kSecClassGenericPassword|security\s+add-generic-password|simctl\s+keychain/, why: "a Keychain writer kept in the repository; Greenroom writes the Keychain from outside the app now" },
  { code: "launch-argument-session", pattern: /ProcessInfo\.processInfo\.(arguments|environment)|launchArguments|SIMCTL_CHILD_|simctl\s+launch[^\n]*--env|CommandLine\.arguments/, why: "a launch argument or environment read that could carry a session" },
  { code: "url-scheme-token", pattern: /(getInitialURL|openURL|Linking\.addEventListener|handleOpenURL|onOpenURL)[\s\S]{0,300}?(token|session|refresh)/i, why: "a URL scheme handler near token or session handling" },
  { code: "debug-session-endpoint", pattern: /\/(debug|test|qa|greenroom)\/(session|auth|login|token)/i, why: "a debug endpoint that hands out or accepts a session" },
  { code: "dev-sign-in-bypass", pattern: /__DEV__[^\n]{0,120}(signIn|completeSignIn|setSession|login)|(fixture|bypass|fake|mock)[- _]?(sign[- ]?in|login|session|auth)/i, why: "a development sign-in bypass; confirm it is not compiled into the walked build" },
];

function readPackage(root, projectRoot) {
  const pkg = readJson(path.join(root, projectRoot, "package.json"));
  const deps = pkg ? { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } : {};
  return { pkg, deps };
}

function findProjectRoot(root) {
  if (exists(path.join(root, "package.json")) || walk(root, { extensions: /\.(xcodeproj|xcworkspace)$/, limit: 200 }).length) return ".";
  for (const candidate of ["apps/web", "apps/mobile", "app", "web", "mobile", "client", "frontend", "packages/app", "packages/web"]) {
    if (exists(path.join(root, candidate, "package.json"))) return candidate;
  }
  return ".";
}

function detectFramework(root, projectRoot, deps, files) {
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  const xcode = files.filter((file) => /\.(xcodeproj|xcworkspace)$/.test(file) && !file.includes("/Pods/"));
  if (has("expo")) return { framework: "expo", platform: "ios" };
  if (has("react-native")) return { framework: "react-native", platform: "ios" };
  if (has("next")) return { framework: "next", platform: "web" };
  if (has("vite")) return { framework: "vite", platform: "web" };
  if (Object.keys(deps).length) return { framework: "custom-web", platform: "web" };
  const swift = files.some((file) => file.startsWith(prefix) && file.endsWith(".swift"));
  if (swift || xcode.length) return { framework: "swiftui", platform: "ios" };
  if (files.some((file) => file.endsWith("index.html"))) return { framework: "custom-web", platform: "web" };
  return { framework: "unknown", platform: "web" };
}

function expoRouteId(relPath) {
  const segments = relPath.replace(/\.(tsx?|jsx?|mjs)$/, "").split("/");
  const kept = segments.map((segment) => segment.replace(/^\[\.\.\.(.+)\]$/, "*$1").replace(/^\[(.+)\]$/, ":$1"));
  if (kept[kept.length - 1] === "index") kept.pop();
  return `/${kept.join("/")}`;
}

const MODULE_EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
function resolveModulePath(base, fileSet) {
  for (const extension of MODULE_EXTENSIONS) { const candidate = `${base}${extension}`; if (fileSet.has(candidate)) return candidate; }
  return null;
}
function resolveImport(fromFile, specifier, files) {
  if (!specifier.startsWith(".")) return null;
  return resolveModulePath(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)), files instanceof Set ? files : new Set(files));
}

// Import aliases: tsconfig/jsconfig `paths` (with `baseUrl`), Expo's base
// tsconfig (`@/*` -> the project root), and babel module-resolver `alias`.
// Read once per project; every alias maps a specifier prefix to directories.
function loadAliases(root, projectRoot) {
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  const aliases = [];
  const stripJsonComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const text = readText(path.join(root, projectRoot, name)); if (!text) continue;
    let json; try { json = JSON.parse(stripJsonComments(text)); } catch { continue; }
    const baseUrl = json?.compilerOptions?.baseUrl ?? ".";
    for (const [pattern, targets] of Object.entries(json?.compilerOptions?.paths ?? {})) {
      aliases.push({ prefix: pattern.replace(/\*$/, ""), exact: !pattern.endsWith("*"), targets: (Array.isArray(targets) ? targets : [targets]).map((target) => path.posix.normalize(path.posix.join(prefix, baseUrl, String(target).replace(/\*$/, "")))) });
    }
    if (/expo\/tsconfig\.base/.test(json?.extends ?? "") && !aliases.some((alias) => alias.prefix === "@/")) aliases.push({ prefix: "@/", exact: false, targets: [prefix || "."] });
  }
  for (const name of ["babel.config.js", "babel.config.cjs", ".babelrc", ".babelrc.js"]) {
    const text = readText(path.join(root, projectRoot, name)); if (!text) continue;
    const block = text.match(/alias\s*:\s*\{([^}]*)\}/)?.[1] ?? "";
    for (const match of block.matchAll(/["'`]([^"'`]+)["'`]\s*:\s*["'`]([^"'`]+)["'`]/g)) aliases.push({ prefix: match[1], exact: !match[1].endsWith("/"), targets: [path.posix.normalize(path.posix.join(prefix, match[2]))] });
  }
  return aliases;
}

const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["'`]([^"'`\n]+)["'`]|\brequire\(\s*["'`]([^"'`\n]+)["'`]\s*\)|\bimport\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g;
function importsOf(text) {
  return [...text.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3]).filter(Boolean);
}

function resolveSpecifier(fromFile, specifier, fileSet, aliases, prefix) {
  if (specifier.startsWith(".")) return resolveImport(fromFile, specifier, fileSet);
  for (const alias of aliases) {
    if (alias.exact ? specifier !== alias.prefix && !specifier.startsWith(`${alias.prefix}/`) : !specifier.startsWith(alias.prefix)) continue;
    const rest = alias.exact ? specifier.slice(alias.prefix.length).replace(/^\//, "") : specifier.slice(alias.prefix.length);
    for (const target of alias.targets) { const found = resolveModulePath(path.posix.normalize(path.posix.join(target, rest)), fileSet); if (found) return found; }
  }
  // A bare path that exists in the tree (tsconfig baseUrl ".") is a project file, not a package.
  return /^(src|app|lib|components|features|screens|Sources)\//.test(specifier) ? resolveModulePath(path.posix.normalize(`${prefix}${specifier}`), fileSet) : null;
}

// Every project file a source file reaches through its imports (transitively,
// bounded), excluding tests and stories. This is what a screen depends on,
// so it is what a state's `sources` should list and what `sharedSources`
// is derived from (the files every route reaches).
function importClosure(root, file, { fileSet, aliases, prefix, texts, limit = 400 }) {
  const seen = new Set();
  const queue = [file];
  while (queue.length && seen.size < limit) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const text = texts.get(current) ?? readText(path.join(root, current)) ?? "";
    texts.set(current, text);
    for (const specifier of importsOf(text)) {
      const resolved = resolveSpecifier(current, specifier, fileSet, aliases, prefix);
      if (resolved && !seen.has(resolved) && /\.(tsx?|jsx?|mjs)$/.test(resolved) && !/\.(test|spec|stories)\./.test(resolved)) queue.push(resolved);
    }
  }
  seen.delete(file);
  return [...seen];
}

// A route file that only redirects (`<Redirect href=... />` and no other
// element) is not a screen: it belongs in sharedSources, because changing
// where it sends users affects every entry.
function isRedirectOnly(text) {
  if (!/<Redirect\b/.test(text)) return false;
  const body = text.replace(/^\s*import[^\n]*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const elements = [...body.matchAll(/<([A-Z][A-Za-z0-9.]*)\b/g)].map((match) => match[1]).filter((name) => name !== "Redirect");
  return elements.length === 0;
}

function detectRouter(root, projectRoot, framework, deps, files) {
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  const routes = [];
  const layouts = [];
  if (framework === "expo" && deps["expo-router"]) {
    const appDir = `${prefix}app/`;
    for (const file of files) {
      if (!file.startsWith(appDir) || !/\.(tsx?|jsx?)$/.test(file) || /\.(test|spec|stories)\./.test(file)) continue;
      const rel = file.slice(appDir.length);
      const base = path.posix.basename(rel);
      const dir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
      if (base.startsWith("_layout.")) { layouts.push({ file, dir, text: readText(path.join(root, file)) ?? "" }); continue; }
      if (base.startsWith("+") || base.startsWith("_") || base.startsWith(".")) continue;
      routes.push({ id: expoRouteId(rel), file, dir, redirectOnly: isRedirectOnly(readText(path.join(root, file)) ?? "") });
    }
    return { routerKind: "expo-router", graphPaths: [`${prefix}app`], routes, layouts };
  }
  if ((framework === "expo" || framework === "react-native") && Object.keys(deps).some((name) => name.startsWith("@react-navigation/"))) {
    const candidates = files.filter((file) => file.startsWith(prefix) && /\.(tsx?|jsx?)$/.test(file)).map((file) => ({ file, text: readText(path.join(root, file)) ?? "" })).filter(({ text }) => /<(?:\w+\.)?Screen\s+[^>]*\bname\s*=/.test(text) && /create(?:Native)?(?:Stack|BottomTab|Drawer|MaterialTopTab)Navigator/.test(text));
    candidates.sort((a, b) => (b.text.match(/<(?:\w+\.)?Screen\s/g)?.length ?? 0) - (a.text.match(/<(?:\w+\.)?Screen\s/g)?.length ?? 0));
    const graph = candidates[0];
    if (graph) {
      for (const match of graph.text.matchAll(/<(?:\w+\.)?Screen\s+[^>]*\bname\s*=\s*["'`]([^"'`]+)["'`](?:[^>]*\bcomponent\s*=\s*\{?\s*([A-Za-z0-9_]+)\s*\}?)?/g)) {
        const component = match[2];
        const importMatch = component && graph.text.match(new RegExp(`import\\s+(?:\\{[^}]*\\b${component}\\b[^}]*\\}|${component})\\s+from\\s+["']([^"']+)["']`));
        const source = importMatch ? resolveImport(graph.file, importMatch[1], files) : null;
        routes.push({ id: match[1], file: source ?? graph.file, screen: component ?? match[1], dir: "" });
      }
      return { routerKind: "react-navigation", graphPaths: [graph.file], routes, layouts: [] };
    }
  }
  if (framework === "swiftui") {
    const swiftFiles = files.filter((file) => file.startsWith(prefix) && file.endsWith(".swift") && !/Tests?\//.test(file));
    const appFile = swiftFiles.find((file) => /@main/.test(readText(path.join(root, file)) ?? ""));
    const sourceRoot = appFile ? path.posix.dirname(appFile) : (swiftFiles[0] ? path.posix.dirname(swiftFiles[0]) : `${prefix}Sources`);
    for (const file of swiftFiles) {
      const text = readText(path.join(root, file)) ?? "";
      for (const match of text.matchAll(/struct\s+([A-Z][A-Za-z0-9_]*(?:View|Screen|Page))\s*:\s*(?:some\s+)?View\b/g)) routes.push({ id: match[1].replace(/View$/, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), file, screen: match[1], dir: "" });
    }
    return { routerKind: "swiftui", graphPaths: [sourceRoot], routes, layouts: [] };
  }
  if (framework === "next") {
    for (const file of files) {
      const match = file.match(new RegExp(`^${escapeRegExp(prefix)}(?:src/)?app/(.*?)page\\.(tsx?|jsx?|mdx?)$`));
      if (!match) continue;
      const route = `/${match[1].split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment)).join("/")}`;
      routes.push({ id: route, file, screen: null, dir: "" });
    }
    if (routes.length) return { routerKind: null, graphPaths: null, routes, layouts: [] };
  }
  if (framework === "vite" || framework === "custom-web" || framework === "next") {
    for (const file of files) {
      const match = file.match(new RegExp(`^${escapeRegExp(prefix)}src/(pages|screens|views|routes)/([^/]+?)(?:/index)?\\.(tsx?|jsx?|vue|svelte)$`));
      if (!match || /\.(test|spec|stories)\./.test(file)) continue;
      routes.push({ id: match[2].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), file, screen: match[2], dir: "" });
    }
    // hash-spa: one file defining a `views` object (the harness's own extractor's shape).
    const views = files.find((file) => file.startsWith(prefix) && /\.(js|mjs|ts)$/.test(file) && /(?:const|let|var|export\s+const)\s+views\s*=\s*\{/.test(readText(path.join(root, file)) ?? ""));
    if (views) return { routerKind: "hash-spa", graphPaths: [views], routes, layouts: [] };
  }
  return { routerKind: null, graphPaths: null, routes, layouts: [] };
}

function gatherHosts(root, projectRoot, deps, files) {
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  const literal = new Map();
  const envKeys = new Map();
  const keyEnv = new Map();
  const configHosts = [];
  for (const file of files) {
    if (!file.startsWith(prefix) || NOT_THE_APP.test(file.slice(prefix.length)) || !SOURCE_EXT.test(file) || /(^|\/)(package-lock|yarn|pnpm-lock|Podfile)\.(json|lock)$/.test(file) || file.endsWith(".lock") || /\.(test|spec)\./.test(file)) continue;
    const text = readText(path.join(root, file)); if (text === null || text.length > 2_000_000) continue;
    for (const match of text.matchAll(/https?:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d+)?/gi)) {
      const host = match[1].toLowerCase();
      if (!literal.has(host)) literal.set(host, new Set());
      literal.get(host).add(file);
    }
    for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*(?:URL|HOST|HOSTNAME|ENDPOINT|DSN|ORIGIN|DOMAIN|BASE)[A-Z0-9_]*)/g)) {
      if (!envKeys.has(match[1])) envKeys.set(match[1], new Set());
      envKeys.get(match[1]).add(file);
    }
    // SDK keys the build reads (`process.env.*_KEY`, `*_API_KEY`, `*_SDK_KEY`,
    // `*_TOKEN`): an SDK that refuses to start without one needs a TEST
    // project's PUBLIC key in prepare; a private key never goes there.
    for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_APP_ID|_CLIENT_ID)(?:_[A-Z0-9_]+)?)\b/g)) {
      if (/(URL|HOST|DSN)/.test(match[1])) continue;
      if (!keyEnv.has(match[1])) keyEnv.set(match[1], new Set());
      keyEnv.get(match[1]).add(file);
    }
  }
  // Build-profile environments (eas.json, .env.example) name the isolated backend candidates.
  const eas = readJson(path.join(root, projectRoot, "eas.json"));
  for (const [profile, config] of Object.entries(eas?.build ?? {})) for (const [key, value] of Object.entries(config?.env ?? {})) {
    const host = String(value).match(/^https?:\/\/([^/:]+)/)?.[1]; if (host) configHosts.push({ host, from: `eas.json build.${profile}.env.${key}` });
  }
  for (const envFile of [".env.example", ".env.sample", ".env.test.example", ".env.staging.example"]) {
    const text = readText(path.join(root, projectRoot, envFile)); if (!text) continue;
    for (const line of text.split("\n")) { const match = line.match(/^([A-Z0-9_]+)\s*=\s*"?https?:\/\/([^/:"\s]+)/); if (match) configHosts.push({ host: match[2], from: `${envFile} ${match[1]}` }); }
  }
  const sdk = [];
  for (const entry of KNOWN_SDK_HOSTS) for (const name of Object.keys(deps)) if (entry.dependency.test(name)) sdk.push({ dependency: name, hosts: entry.hosts, note: entry.note });
  const fonts = [...literal.keys()].filter((host) => /fonts\.(googleapis|gstatic)\.com$/.test(host));
  const web = [...literal.keys()].filter((host) => /(cdn|static|assets|media|img|images)\./.test(host));
  const classified = [...literal.entries()].map(([host, fileSet]) => ({ host, files: [...fileSet].slice(0, 6), count: fileSet.size, kind: /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(host) ? "local" : LINK_ONLY_HOSTS.test(host) ? "probably-a-link" : fonts.includes(host) ? "font-cdn" : web.includes(host) ? "asset-cdn" : "api-or-service" })).sort((a, b) => b.count - a.count);
  const sdkKeys = [...keyEnv.entries()].map(([key, fileSet]) => ({ key, files: [...fileSet].slice(0, 4), kind: PRIVATE_KEY_NAME.test(key) ? "private-looking" : PUBLIC_SDK_KEY_NAME.test(key) ? "public-sdk-key" : "unknown" }));
  return { literal: classified, envKeys: [...envKeys.entries()].map(([key, fileSet]) => ({ key, files: [...fileSet].slice(0, 4) })), sdkKeys, sdk, configHosts };
}
// Public SDK keys (publishable by design: they ship inside the app binary)
// versus anything that is a credential. Only the first kind may be exported
// in prepare, and only a TEST project's.
const PUBLIC_SDK_KEY_NAME = /(REVENUECAT|PURCHASES|POSTHOG|AMPLITUDE|MIXPANEL|SEGMENT_WRITE|STRIPE_PUBLISHABLE|MAPBOX|GOOGLE_MAPS|MAPS_API|SUPABASE_ANON|FIREBASE|ALGOLIA_SEARCH|INTERCOM_APP|ONESIGNAL_APP|BRANCH_KEY|ADJUST_APP|SENTRY_DSN|PUBLIC)/;
const PRIVATE_KEY_NAME = /(SECRET|PRIVATE|SERVICE_ROLE|SERVER_KEY|ADMIN|SIGNING|WEBHOOK|DATABASE|DB_|NEXTAUTH|JWT|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SESSION)/;
// One candidate per key family (EXPO_PUBLIC_ prefix and build-profile
// suffixes folded), for the platform being onboarded, public-looking only.
export function candidateSdkKeys(sdkKeys, platform) {
  const families = new Map();
  for (const entry of sdkKeys.filter((item) => item.kind === "public-sdk-key")) {
    if (platform === "ios" && /ANDROID/.test(entry.key)) continue;
    const family = entry.key.replace(/^EXPO_PUBLIC_/, "").replace(/_(DEVELOPMENT|DEV|PREVIEW|BETA|PRODUCTION|PROD|STAGING|TEST)$/, "");
    const current = families.get(family);
    if (!current || entry.key.length < current.length) families.set(family, entry.key);
  }
  return [...families.values()].sort().slice(0, 6);
}

function detectAuth(root, projectRoot, deps, files, router) {
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  const signals = [];
  const keys = new Set();
  let service = null; let kind = null; let requireAuthentication = false;
  const sources = files.filter((file) => file.startsWith(prefix) && /\.(tsx?|jsx?|swift|m|mm)$/.test(file) && !/\.(test|spec)\./.test(file));
  const texts = new Map(sources.map((file) => [file, readText(path.join(root, file)) ?? ""]));
  if (deps["expo-secure-store"]) {
    kind = "expo-secure-store"; service = "app:no-auth";
    for (const [file, text] of texts) {
      if (!/expo-secure-store|SecureStore|secureStorage|SecureItemAsync/i.test(text)) continue;
      const serviceMatch = text.match(/keychainService\s*:\s*["'`]([^"'`]+)["'`]/); if (serviceMatch) { service = `${serviceMatch[1]}:no-auth`; signals.push({ file, signal: `keychainService "${serviceMatch[1]}"` }); }
      if (/requireAuthentication\s*:\s*true/.test(text)) { requireAuthentication = true; signals.push({ file, signal: "requireAuthentication: true (not importable)" }); }
      const constants = new Map([...text.matchAll(/(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/g)].map((match) => [match[1], match[2]]));
      for (const match of text.matchAll(/\b\w*(?:set|get|delete)(?:Secure)?ItemAsync\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*|["'`][^"'`]+["'`])/g)) {
        const raw = match[1]; const value = /^["'`]/.test(raw) ? raw.slice(1, -1) : constants.get(raw) ?? null;
        if (value) keys.add(value);
        else if (/^[A-Z][A-Z0-9_]*$/.test(raw)) signals.push({ file, signal: `key constant ${raw} defined elsewhere` });
      }
      for (const [name, value] of constants) if (/(TOKEN|SESSION|AUTH|REFRESH|CREDENTIAL)/.test(name) && /(KEY|STORAGE)/.test(name)) keys.add(value);
    }
    // Only the session's own keys are import accounts; a device id or a
    // database key is not a session. The refresh token comes first: an app
    // that refreshes on launch needs only that one.
    const sessionKeys = [...keys].filter((key) => /(refresh|token|session|auth|credential|jwt)/i.test(key) && !/(device|encryption|db_|database|referral|dismiss|promo|onboard|pending)/i.test(key)).sort((a, b) => (/refresh/i.test(b) ? 1 : 0) - (/refresh/i.test(a) ? 1 : 0));
    const other = [...keys].filter((key) => !sessionKeys.includes(key));
    keys.clear(); for (const key of sessionKeys) keys.add(key);
    if (keys.size) signals.push({ file: "(derived)", signal: `session keys in the secure store: ${[...keys].join(", ")}` });
    if (other.length) signals.push({ file: "(derived)", signal: `other secure-store keys, not session accounts: ${other.join(", ")}` });
  }
  if (deps["react-native-keychain"]) {
    kind = kind ?? "keychain";
    for (const [file, text] of texts) for (const match of text.matchAll(/setGenericPassword\s*\(\s*(["'`][^"'`]+["'`]|[A-Za-z_][A-Za-z0-9_]*)[^)]*?(?:service\s*:\s*["'`]([^"'`]+)["'`])?/g)) {
      const account = /^["'`]/.test(match[1]) ? match[1].slice(1, -1) : match[1]; keys.add(account); if (match[2]) service = match[2];
      signals.push({ file, signal: `react-native-keychain account ${account}${match[2] ? ` service ${match[2]}` : ""}` });
    }
  }
  if (!kind) for (const [file, text] of texts) {
    if (!file.endsWith(".swift") || !/SecItemAdd|kSecAttrService/.test(text)) continue;
    kind = "keychain";
    const serviceMatch = text.match(/kSecAttrService[^\n]*?["']([^"']+)["']/); if (serviceMatch) service = serviceMatch[1];
    const accountMatch = text.match(/kSecAttrAccount[^\n]*?["']([^"']+)["']/); if (accountMatch) keys.add(accountMatch[1]);
    signals.push({ file, signal: "native Keychain item" });
  }
  // The sign-in wall: a layout that redirects on an auth flag, or sign-in routes.
  const gatedDirs = [];
  for (const layout of router.layouts ?? []) if (/<Redirect\b/.test(layout.text) && /(isAuthenticated|isSignedIn|isLoggedIn|\bauth\b|\bsession\b|\buser\b)/.test(layout.text)) gatedDirs.push(layout.dir);
  const signInRoutes = (router.routes ?? []).filter((route) => /(sign-?in|login|auth|onboarding|welcome|register|sign-?up)/i.test(route.id)).map((route) => route.id);
  const providers = ["expo-apple-authentication", "@react-native-google-signin/google-signin", "expo-auth-session", "@react-native-firebase/auth", "@clerk/clerk-expo", "@supabase/supabase-js", "react-native-app-auth"].filter((name) => deps[name]);
  // A wall needs a way in: a sign-in route or a provider SDK. A gated layout
  // alone can be an anonymous device account created silently at first launch.
  const signIn = signInRoutes.some((route) => /(sign-?in|login|register|sign-?up)/i.test(route));
  const wall = providers.length > 0 || signIn;
  return { wall, kind, service, accounts: [...keys], requireAuthentication, gatedDirs, signInRoutes, providers, signals };
}

function findImportPaths(root, projectRoot, files) {
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  const findings = [];
  for (const file of files) {
    if (!file.startsWith(prefix) || (!SOURCE_EXT.test(file) && !/\.md$/.test(file))) continue;
    if (file.startsWith(`${prefix}.greenroom/`) || file === `${prefix}${FILES.workflow}` || file.endsWith(".lock") || /(^|\/)package-lock\.json$/.test(file) || /\.(test|spec)\./.test(file)) continue;
    const text = readText(path.join(root, file)); if (text === null || text.length > 2_000_000) continue;
    for (const entry of IMPORT_PATH_PATTERNS) {
      const match = text.match(entry.pattern); if (!match) continue;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ file, line, code: entry.code, why: entry.why, excerpt: text.split("\n")[line - 1].trim().slice(0, 160) });
    }
  }
  return findings;
}

function detectBuild(root, projectRoot, framework, deps, files) {
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  const appJson = readJson(path.join(root, projectRoot, "app.json"));
  const expo = appJson?.expo ?? appJson ?? {};
  const gitignore = readText(path.join(root, ".gitignore")) ?? "";
  const iosIgnored = /^\/?ios\/?\s*$/m.test(gitignore);
  const lockfile = files.find((file) => file === `${prefix}ios/Podfile.lock`) ?? files.find((file) => file.startsWith(prefix) && /(^|\/)Podfile\.lock$/.test(file));
  const lockVersion = lockfile ? readText(path.join(root, lockfile))?.match(/^COCOAPODS:\s*(\d+\.\d+\.\d+)\s*$/m)?.[1] ?? null : null;
  const xcworkspace = walk(path.join(root, projectRoot), { extensions: /\.xcworkspace$/, limit: 50 }).map((file) => `${prefix}${file}`).find((file) => !file.includes(".xcodeproj/")) ?? null;
  const xcodeproj = walk(path.join(root, projectRoot), { extensions: /\.xcodeproj$/, limit: 50 }).map((file) => `${prefix}${file}`).find(() => true) ?? null;
  const name = expo.name?.replace(/[^A-Za-z0-9]/g, "") || (xcworkspace ?? xcodeproj ?? "").split("/").pop()?.replace(/\.(xcworkspace|xcodeproj)$/, "") || null;
  const bundleId = expo.ios?.bundleIdentifier ?? null;
  const sentry = Boolean(deps["@sentry/react-native"] || deps["sentry-expo"]);
  const pkgScripts = readJson(path.join(root, projectRoot, "package.json"))?.scripts ?? {};
  const build = pkgScripts.build ?? null;
  const viteConfig = ["vite.config.ts", "vite.config.js", "vite.config.mjs"].map((file) => path.join(root, projectRoot, file)).find(exists);
  const outputDir = framework === "next" ? ".next" : build?.match(/--outDir\s+(\S+)/)?.[1] ?? (viteConfig ? readText(viteConfig)?.match(/outDir\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "dist" : "dist");
  return { appName: name, bundleId, scheme: name, xcworkspace, xcodeproj, iosIgnored, lockfile: lockfile ?? null, cocoapodsVersion: lockVersion, sentry, buildScript: build, outputDir, hasBuildSimulatorScript: exists(path.join(root, projectRoot, "scripts/build-simulator.sh")) };
}

function expoSlug(root, projectRoot) { const appJson = readJson(path.join(root, projectRoot, "app.json")); return appJson?.expo?.slug ?? appJson?.slug ?? null; }

export function detect(root, { projectRoot: forcedRoot = null } = {}) {
  root = path.resolve(root);
  if (!exists(root)) throw new Error(`${root} does not exist`);
  const files = walk(root);
  const projectRoot = forcedRoot ?? findProjectRoot(root);
  const { pkg, deps } = readPackage(root, projectRoot);
  const { framework, platform } = detectFramework(root, projectRoot, deps, files);
  const router = detectRouter(root, projectRoot, framework, deps, files);
  const hosts = gatherHosts(root, projectRoot, deps, files);
  const auth = detectAuth(root, projectRoot, deps, files, router);
  const importPaths = findImportPaths(root, projectRoot, files);
  const build = detectBuild(root, projectRoot, framework, deps, files);
  const existing = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, exists(path.join(root, file))]));
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  const graph = sourceGraph(root, prefix, files, router, auth);
  const slug = (pkg?.name ?? expoSlug(root, projectRoot) ?? path.basename(root)).replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64);
  return { root, projectRoot, framework, platform, packageName: pkg?.name ?? null, suggestedSlug: SLUG.test(slug) ? slug : "my-app", router: { routerKind: router.routerKind, graphPaths: router.graphPaths, routes: router.routes.map(({ id, file, screen, dir, redirectOnly }) => ({ id, file, screen: screen ?? null, dir, redirectOnly: Boolean(redirectOnly), sources: graph.sources.get(file) ?? [], authenticated: graph.inferred.has(id) ? "inferred" : null })), layouts: (router.layouts ?? []).map((layout) => layout.file) }, sharedSources: graph.sharedSources, auth: { ...auth, inferredAuthenticated: [...graph.inferred.entries()].map(([id, from]) => ({ id, referencedFrom: from })) }, hosts, importPaths, build, existing, fileCount: files.length };
}

// The screen graph from imports: what each route file reaches (its
// `sources`), what every route reaches (`sharedSources`, with the layouts
// and redirect-only routes), and which routes outside a gated layout are
// reachable only from gated screens (an authenticated start, inferred).
function sourceGraph(root, prefix, files, router, auth) {
  const fileSet = new Set(files);
  const aliases = loadAliases(root, prefix ? prefix.slice(0, -1) : ".");
  const texts = new Map();
  const routes = router.routes ?? [];
  const layouts = (router.layouts ?? []).map((layout) => layout.file);
  const routeFiles = new Set(routes.map((route) => route.file));
  const closureOf = new Map();
  const closure = (file) => { if (!closureOf.has(file)) closureOf.set(file, importClosure(root, file, { fileSet, aliases, prefix, texts })); return closureOf.get(file); };
  // Files reached by a route, excluding the router's own route and layout
  // files (a screen that imports another screen's file still owns its own).
  const own = (file) => closure(file).filter((entry) => !routeFiles.has(entry) && !layouts.includes(entry));
  const screens = routes.filter((route) => !route.redirectOnly);
  let common = null;
  for (const route of screens) { const set = new Set(own(route.file)); common = common === null ? set : new Set([...common].filter((entry) => set.has(entry))); }
  // sharedSources = layouts + redirect-only routes + what EVERY screen imports,
  // plus theme/style directories and global stylesheets (which imports cannot
  // see: CSS, design tokens). Never a components directory: feature components
  // live there, and a change to one must scope to the screens that use it.
  const themeDirs = ["src/theme", "src/styles", "src/design", "src/design-system", "app/theme", "styles", "theme", "Sources/Theme", "Sources/DesignSystem"].map((dir) => `${prefix}${dir}`).filter((dir) => files.some((file) => file.startsWith(`${dir}/`))).map((dir) => `${dir}/**`);
  const globalFiles = ["tailwind.config.js", "tailwind.config.ts", "src/index.css", "src/globals.css", "app/globals.css"].map((file) => `${prefix}${file}`).filter((file) => fileSet.has(file));
  const shared = uniq([...layouts, ...routes.filter((route) => route.redirectOnly).map((route) => route.file), ...(screens.length >= 2 && common ? [...common].sort() : []), ...themeDirs, ...globalFiles]);
  const sharedSet = new Set(shared);
  const sources = new Map();
  for (const route of routes) sources.set(route.file, uniq([route.file, ...own(route.file).filter((entry) => !sharedSet.has(entry)).sort()]));

  // Authenticated-by-reachability: a route not under a gated layout whose
  // every reference (`router.push("/session")`, `href="/upgrade"`,
  // `pathname: "/block/[id]"`) comes from gated screens or files only they
  // reach. Files an explicitly signed-out screen (sign-in, onboarding, a
  // redirect, a low-value route) or the root layout also reaches do not
  // count as gated-only.
  const inferred = new Map();
  const gatedDirs = auth?.gatedDirs ?? [];
  const isGatedDir = (route) => gatedDirs.some((dir) => dir === "" ? false : (route.dir === dir || route.dir?.startsWith(`${dir}/`)));
  const signedOutRoute = (route) => (auth?.signInRoutes ?? []).includes(route.id) || route.redirectOnly || LOW_VALUE_ROUTE.test(route.id);
  if (gatedDirs.some((dir) => dir !== "") && routes.length) {
    const gatedLayouts = layouts.filter((file) => gatedDirs.some((dir) => dir && file.startsWith(`${prefix}app/${dir}/`)));
    const signedOutFiles = new Set(routes.filter(signedOutRoute).flatMap((route) => [route.file, ...closure(route.file)]));
    for (const layout of layouts.filter((file) => !gatedLayouts.includes(file))) for (const entry of [layout, ...closure(layout)]) signedOutFiles.add(entry);
    const textOf = (file) => { if (!texts.has(file)) texts.set(file, readText(path.join(root, file)) ?? ""); return texts.get(file); };
    const sourceFiles = files.filter((file) => file.startsWith(prefix) && /\.(tsx?|jsx?|mjs)$/.test(file) && !/\.(test|spec|stories)\./.test(file) && !NOT_THE_APP.test(file.slice(prefix.length)));
    const referencePattern = (id) => {
      const staticPart = id.includes(":") || id.includes("*") ? id.slice(0, id.search(/[:*]/)) : id;
      const groupless = staticPart.replace(/\/\([^)]*\)/g, "");
      const alternatives = uniq([staticPart, groupless]).filter(Boolean).map(escapeRegExp).join("|");
      return new RegExp(`["'\`](?:${alternatives})(?:["'\`?]|\\$\\{|\\[)`);
    };
    let gatedFiles = new Set(routes.filter(isGatedDir).flatMap((route) => [route.file, ...closure(route.file)]).concat(gatedLayouts));
    for (let round = 0; round < 4; round += 1) {
      let changed = false;
      for (const route of routes) {
        if (isGatedDir(route) || signedOutRoute(route) || inferred.has(route.id)) continue;
        const pattern = referencePattern(route.id);
        const refs = sourceFiles.filter((file) => file !== route.file && pattern.test(textOf(file)));
        if (!refs.length) continue;
        const gatedOnly = refs.every((file) => gatedFiles.has(file) && !signedOutFiles.has(file));
        if (!gatedOnly) continue;
        inferred.set(route.id, refs.slice(0, 6));
        for (const entry of [route.file, ...closure(route.file)]) gatedFiles.add(entry);
        changed = true;
      }
      if (!changed) break;
    }
  }
  return { sources, sharedSources: shared, inferred };
}

// ---------------------------------------------------------------- drafting
// The paste-ready workflow, built the way packages/production/src/setup.js
// builds it (same lines, same comments) so a plain draft is byte-identical to
// the product's own download; the Expo, bare React Native and Xcode prepare
// recipes and the `secrets:` block are this script's additions.
function workflowInputs({ platform, framework, projectRoot, slug, bundleId, appName, device, allowedHosts, prepare, artifactPath }) {
  const root = projectRoot ?? ".";
  const cd = root === "." ? [] : [`  cd ${root}`];
  const prefix = root === "." ? "" : `${root}/`;
  if (platform === "web") {
    const next = framework === "next";
    const serve = next ? "  npm run start -- --hostname 127.0.0.1 --port 4173 > serve.log 2>&1 &" : `  npx --yes serve@14.2.4 -l 4173 -s ${artifactPath ?? "dist"} > serve.log 2>&1 &`;
    return ["platform: web", `app-id: ${slug}`, "# Review build commands and test-environment variables before merging.", "prepare: |", ...cd, ...(prepare ?? ["  npm ci && npm run build", serve]),
      `  for i in $(seq 1 30); do curl -sf ${WEB_PREVIEW_URL} >/dev/null && break; sleep 1; done`, `  curl -fsS ${WEB_PREVIEW_URL} >/dev/null`,
      `target-url: ${WEB_PREVIEW_URL}`, `artifact-path: ${prefix}${artifactPath ?? (next ? ".next" : "dist")}`];
  }
  return ["platform: ios", "runs-on: macos-26", `app-id: ${slug}`, `app: ${bundleId ?? "REPLACE_WITH_TEST_BUNDLE_ID"}`, `device: ${device ?? "Greenroom QA"}`,
    "# Required: supply a simulator build script for your Xcode or Expo project.", "prepare: |", ...cd, ...(prepare ?? ["  ./scripts/build-simulator.sh"]),
    `artifact-path: ${prefix}${artifactPath ?? `build/${appName ?? "REPLACE_WITH_APP_NAME"}.app`}`, `allowed-hosts: ${allowedHosts?.length ? allowedHosts.join(",") : "REPLACE_WITH_TEST_BACKEND_HOST"}`];
}

const indent = (lines, spaces) => lines.map((line) => " ".repeat(spaces) + line).join("\n");

export function workflowYaml(options) {
  const secrets = options.auth?.mechanism === "session_import" ? `\n    # The disposable session for a signed-in start (auth.mechanism session_import).\n    # The value lives only in the repository secret; the manifest names it.\n    secrets:\n      session: \${{ secrets.${options.auth.secret} }}` : "";
  return `name: Greenroom
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

jobs:
  greenroom:
    permissions:
      contents: read
      id-token: write
    # Greenroom's reusable workflow, pinned to a reviewed commit. The job is
    # defined there, so a pull request cannot change what it does.
    uses: ${options.uses}
    with:
${indent(workflowInputs(options), 6)}
      # Source upload is off by default. Enable only after repository and
      # Greenroom workspace policy have both been reviewed.
      source-upload-allowed: "false"${secrets}`;
}

// The simulator build for the prepare block: Expo (prebuild when ios/ is not
// tracked), bare React Native, or a plain Xcode project. CocoaPods is pinned
// to the lockfile's version because the hosted image refuses a lockfile from
// another version (setup preflight names this cocoapods-lockfile-drift). No
// CODE_SIGNING_ALLOWED=NO: an unsigned simulator build cannot use the
// Keychain, which a session import needs.
function iosPrepare(report, { appName, scheme, projectRoot, sdkKeys = [] }) {
  const lines = ["  set -euo pipefail"];
  const { build, framework, hosts } = report;
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  const urlKeys = hosts.envKeys.map((entry) => entry.key).filter((key) => !/SCHEME|DSN|STORE|DATABASE|^DB_/.test(key));
  const backendKeys = urlKeys.filter((key) => /(API|BACKEND|SERVER)_?(URL|HOST|ENDPOINT|BASE)/.test(key)).slice(0, 4);
  const otherKeys = urlKeys.filter((key) => !backendKeys.includes(key)).slice(0, 6);
  if (backendKeys.length) lines.push("  # Point the build at the isolated backend named in allowedHosts.", ...backendKeys.map((key) => `  export ${key}=REPLACE_WITH_ISOLATED_BACKEND_URL`));
  if (otherKeys.length) lines.push(`  # Other build-time hosts this app reads (${otherKeys.join(", ")}): every host they name must be in allowedHosts, or leave them unset so the feature is off in the test build.`);
  // Public SDK keys the app needs to start (an SDK that throws without one
  // takes the whole startup chain down). A TEST project's PUBLIC key only;
  // prepare runs with no credentials and this file is readable by anyone
  // with the repository, so a private key never goes here.
  if (sdkKeys.length) lines.push("  # Public SDK keys the app needs to start: a TEST project's public key, never a private one (prepare has no credentials and cannot read repository secrets). A GitHub Actions variable (vars.NAME) keeps the value out of Git.", ...sdkKeys.map((key) => `  export ${key}=REPLACE_WITH_${(key.replace(/^EXPO_PUBLIC_/, "").match(/^([A-Z0-9]+)/)?.[1] ?? "SDK")}_TEST_PROJECT_PUBLIC_SDK_KEY`));
  else {
    const candidates = candidateSdkKeys(hosts.sdkKeys ?? [], "ios");
    if (candidates.length) lines.push(`  # This app reads public SDK keys (${candidates.join(", ")}). If an SDK refuses to start without one (an init that throws), re-run the draft with --sdk-keys NAME to export a TEST project's public key here; otherwise leave them unset so the SDK stays off in the test build.`);
  }
  if (build.sentry) lines.push("  export SENTRY_DISABLE_AUTO_UPLOAD=true SENTRY_ALLOW_FAILURE=true  # no source-map upload from this secretless job");
  if (framework === "expo" || framework === "react-native") {
    lines.push("  npm ci --no-audit --no-fund");
    if (framework === "expo" && (build.iosIgnored || !build.xcworkspace)) lines.push("  npx --no-install expo prebuild --platform ios --no-install");
    if (build.lockfile && build.lockfile !== `${prefix}ios/Podfile.lock`) lines.push(`  cp ${build.lockfile.slice(prefix.length)} ios/Podfile.lock`);
    if (build.cocoapodsVersion) lines.push(`  sudo gem install cocoapods -v ${build.cocoapodsVersion} --no-document`, `  pod _${build.cocoapodsVersion}_ install --project-directory=ios --deployment`);
    else {
      // No lockfile in the tree: never an unpinned `pod install` (the hosted
      // image would resolve pods with whatever CocoaPods it ships, differently
      // from the owner's machine and from run to run). The owner produces
      // .greenroom/Podfile.lock once, locally, and the version it names is pinned here.
      lines.push(
        "  # No Podfile.lock is tracked (ios/ is generated), so pods and the CocoaPods version must be pinned or CI resolves them differently every run. Produce the lockfile once, locally:",
        "  #   npx expo prebuild --platform ios --no-install && pod install --project-directory=ios",
        "  #   mkdir -p .greenroom && cp ios/Podfile.lock .greenroom/Podfile.lock   # commit it; its last line (COCOAPODS: X.Y.Z) is the version to pin below",
        "  cp .greenroom/Podfile.lock ios/Podfile.lock",
        "  sudo gem install cocoapods -v REPLACE_WITH_COCOAPODS_VERSION --no-document",
        "  pod _REPLACE_WITH_COCOAPODS_VERSION_ install --project-directory=ios --deployment",
      );
    }
  }
  const workspace = build.xcworkspace ? `-workspace ${build.xcworkspace.slice(prefix.length)}` : framework === "expo" ? `-workspace ios/${appName}.xcworkspace` : build.xcodeproj ? `-project ${build.xcodeproj.slice(prefix.length)}` : `-workspace ios/${appName}.xcworkspace`;
  lines.push(`  xcodebuild ${workspace} -scheme ${scheme} -configuration Release -sdk iphonesimulator -destination "generic/platform=iOS Simulator" -derivedDataPath "$RUNNER_TEMP/DerivedData" build`,
    `  mkdir -p build && rm -rf build/${appName}.app && cp -R "$RUNNER_TEMP/DerivedData/Build/Products/Release-iphonesimulator/${appName}.app" build/${appName}.app`);
  if (framework === "expo" || framework === "react-native") lines.push(`  test -f build/${appName}.app/main.jsbundle  # Metro-free: the JS bundle must be embedded`);
  return lines;
}

function manifestSkeleton(platform, repo) {
  if (repo?.environmentJsonSkeleton) return JSON.parse(repo.environmentJsonSkeleton(platform));
  const web = platform === "web";
  return { schemaVersion: "1.0", classification: "test", isolated: true, resetStrategy: web ? "ephemeral_deployment" : "fresh_install", networkControl: web ? "playwright" : "sandboxed_backend", allowedHosts: [web ? "127.0.0.1" : "api.example.test"], productionHosts: [] };
}

// A screen name from a route: groups dropped, a dynamic segment reads as
// "Detail", the root reads as "Home" (`/(tabs)/progress/competition/:id` is
// ProgressCompetitionDetailScreen). Unique per route, unlike the file name.
function screenNameFor(route, platform) {
  if (route.screen) return route.screen;
  const segments = route.id.split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment)).map((segment) => (segment.startsWith(":") || segment.startsWith("*")) ? "detail" : segment);
  const words = segments.length ? segments : ["home"];
  const pascal = words.map((word) => word.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ?? "").toUpperCase()).replace(/^./, (c) => c.toUpperCase())).join("");
  return platform === "ios" && !/(View|Screen|Page)$/.test(pascal) ? `${pascal}Screen` : pascal;
}
const LOW_VALUE_ROUTE = /(^|\/)(legal|modals?|diagnostics?|debug|dev|storybook|playground|licen[cs]es?|privacy|terms)(\/|$)/i;

// The contract allows 50 globs per state. A closure larger than that is
// collapsed directory by directory (the biggest first) until it fits; a
// directory glob still scopes correctly, just less finely.
export function capSources(entries, limit = 50) {
  let current = uniq(entries);
  while (current.length > limit) {
    const groups = new Map();
    for (const entry of current) { if (entry.includes("*")) continue; const dir = path.posix.dirname(entry); if (dir === "." ) continue; if (!groups.has(dir)) groups.set(dir, []); groups.get(dir).push(entry); }
    const biggest = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
    if (!biggest || biggest[1].length < 2) {
      // Only singletons left: collapse them to their parent directories.
      const parents = new Map();
      for (const entry of current) { const dir = entry.includes("*") ? path.posix.dirname(entry.replace(/\/\*\*$/, "")) : path.posix.dirname(entry); if (!parents.has(dir)) parents.set(dir, []); parents.get(dir).push(entry); }
      const [dir] = [...parents.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
      if (dir === "." || dir === "") return current.slice(0, limit);
      current = uniq(current.map((entry) => (entry === dir || entry.startsWith(`${dir}/`)) ? `${dir}/**` : entry));
      continue;
    }
    const [dir, members] = biggest;
    current = uniq(current.map((entry) => members.includes(entry) ? `${dir}/**` : entry));
  }
  return current;
}

function toStates(report, { auth, maxStates = 20, exclude = [], authenticated = [], entryOverride = null }) {
  const { router, platform } = report;
  const prefix = report.projectRoot === "." ? "" : `${report.projectRoot}/`;
  const listed = (route, ids) => ids.some((id) => id === route.id || (id.endsWith("*") && route.id.startsWith(id.slice(0, -1))));
  const gated = (route) => auth.mechanism === "session_import" && (listed(route, authenticated) || route.authenticated === "inferred" || report.auth.gatedDirs.some((dir) => dir === "" ? !report.auth.signInRoutes.includes(route.id) : (route.dir === dir || route.dir?.startsWith(`${dir}/`))));
  const featureDirs = (name) => ["src/features", "src/screens", "src/modules", "features", "src/pages"].map((dir) => `${prefix}${dir}/${name}`).filter((dir) => exists(path.join(report.root, dir))).map((dir) => `${dir}/**`);
  // Redirect-only routes are not screens (their file is in sharedSources).
  let routes = router.routes.filter((route) => !listed(route, exclude) && !route.redirectOnly);
  // Tab screens first, then everything but legal/modal/diagnostic screens,
  // shallowest first; the cap keeps the head of that order and the report
  // lists the rest.
  routes.sort((a, b) => (a.id.includes("(tabs)") ? 0 : 1) - (b.id.includes("(tabs)") ? 0 : 1) || (LOW_VALUE_ROUTE.test(a.id) ? 1 : 0) - (LOW_VALUE_ROUTE.test(b.id) ? 1 : 0) || a.id.split("/").length - b.id.split("/").length || a.id.localeCompare(b.id));
  const candidates = routes;
  if (routes.length > maxStates) routes = routes.slice(0, maxStates);
  // Only routes the cap dropped are "omitted"; excluded and redirect-only routes were never candidates.
  const omitted = candidates.filter((route) => !routes.includes(route)).map((route) => route.id);
  const states = routes.map((route) => {
    const screen = screenNameFor(route, platform);
    const feature = path.posix.basename(route.file).replace(/\.[^.]+$/, "").replace(/^index$/, path.posix.basename(path.posix.dirname(route.file))).toLowerCase();
    // sources = the route file plus every project file it reaches through
    // imports (minus sharedSources), plus a feature directory named after it.
    const state = { id: route.id, screen, route: route.id, sources: capSources(uniq([route.file, ...(route.sources ?? []).filter((file) => file !== route.file), ...featureDirs(feature)])), goal: `Reach ${screen} and confirm its primary content and primary action are visible. REPLACE with the observable outcome a user must achieve here.` };
    if (gated(route)) state.identity = { authenticated: true };
    return state;
  });
  if (!states.length) {
    const web = platform === "web";
    states.push({ id: "home", screen: "Home", route: web ? "/" : "HomeView", sources: [web ? `${prefix}src/**` : `${prefix}Sources/**`], goal: "Land on the home screen and confirm its primary action is visible. REPLACE with this app's real screens." });
  }
  // Where a fresh launch lands: the signed-in home for an imported session;
  // the onboarding or sign-in route when the app has a wall and starts
  // signed out; otherwise the index/home/today route.
  const home = states.find((state) => /^\/?(index|home|today|\(tabs\)\/(today|home|index))$/.test(state.id) || state.id === "/")?.id;
  const wallEntry = auth.mechanism !== "session_import" && report.auth.gatedDirs.length ? states.find((state) => report.auth.signInRoutes.includes(state.id))?.id : null;
  const entry = entryOverride ?? wallEntry ?? home ?? states.find((state) => !state.identity)?.id ?? states[0].id;
  const contract = { schemaVersion: "1.0", entryState: entry };
  if (router.routerKind && router.graphPaths) { contract.routerKind = router.routerKind; contract.graphPaths = router.graphPaths; }
  contract.sharedSources = uniq([...report.sharedSources, ".greenroom/**"]);
  contract.states = states;
  contract.transitions = [];
  return { contract, omitted };
}

const list = (value) => String(value).split(",").map((entry) => entry.trim()).filter(Boolean);

export async function draft(root, values) {
  const report = detect(root, { projectRoot: values.root ?? null });
  const repo = await loadRepoModules();
  const platform = values.platform ?? report.platform;
  const framework = values.framework ?? report.framework;
  const projectRoot = values.root ?? report.projectRoot;
  const slug = values.app ?? report.suggestedSlug;
  if (!SLUG.test(slug)) throw new Error("--app must be a lowercase slug (a-z, 0-9, . _ -)");
  if (!["web", "ios"].includes(platform)) throw new Error("--platform must be web or ios");
  const pin = await resolvePin(values, platform);
  if (!pin) throw new Error("No workflow pin: pass --pin <sha> (from the quickstart's uses: line) or drop --offline so the docs can be read");
  const mechanism = values.auth ?? (report.auth.wall && platform === "ios" ? "session_import" : "signed_out");
  if (!["signed_out", "session_import"].includes(mechanism)) throw new Error("--auth must be signed_out or session_import");
  const secret = values.secret ?? "GREENROOM_SESSION";
  if (mechanism === "session_import") {
    if (platform !== "ios") throw new Error("session import is supported for iOS runs only");
    if (!SECRET_NAME.test(secret)) throw new Error("--secret is the NAME of the repository secret (A-Z, 0-9, _), never its value");
  }
  const accounts = values.accounts ? list(values.accounts) : report.auth.accounts;
  const targetKind = values["target-kind"] ?? report.auth.kind ?? "expo-secure-store";
  const service = values.service ?? report.auth.service ?? "app:no-auth";
  const auth = mechanism === "session_import" ? { mechanism, secret, target: { kind: targetKind, service, accounts: accounts.length ? accounts.slice(0, 8) : ["REPLACE_WITH_SESSION_KEY"] }, reset: "fresh_install" } : { mechanism: "signed_out" };
  if (values["access-group"] && auth.mechanism === "session_import") auth.target.accessGroup = values["access-group"];

  const allowedHosts = values["allowed-hosts"] ? list(values["allowed-hosts"]) : null;
  const productionHosts = values["production-hosts"] ? list(values["production-hosts"]) : uniq([...report.hosts.literal.filter((entry) => entry.kind === "api-or-service" || entry.kind === "asset-cdn").map((entry) => entry.host), ...report.hosts.sdk.flatMap((entry) => entry.hosts).filter((host) => !host.startsWith("<") && host !== "ingest.sentry.io")]);
  const manifest = manifestSkeleton(platform, repo);
  if (platform === "web") manifest.allowedHosts = uniq(["127.0.0.1", ...(allowedHosts ?? report.hosts.literal.filter((entry) => entry.kind === "font-cdn").map((entry) => entry.host))]);
  else manifest.allowedHosts = allowedHosts ?? ["REPLACE_WITH_TEST_BACKEND_HOST"];
  manifest.productionHosts = productionHosts.filter((host) => !manifest.allowedHosts.map((value) => value.toLowerCase()).includes(host.toLowerCase()));
  manifest.sandboxPurchases = values["sandbox-purchases"] === "true" || values["sandbox-purchases"] === true;
  if (platform === "ios") manifest.notes = values.notes ?? `${framework === "expo" ? "Release simulator build" : "Simulator build"} compiled against the isolated test backend in allowedHosts (sandboxed_backend); production hosts are listed so a walk can prove it never reached one.`;
  manifest.auth = auth;

  const { contract, omitted } = toStates(report, { auth, exclude: values.exclude ? list(values.exclude) : [], authenticated: values.authenticated ? list(values.authenticated) : [], entryOverride: values.entry ?? null });
  if (values.entry && !contract.states.some((state) => state.id === values.entry)) throw new Error(`--entry ${values.entry} is not a drafted state`);
  const appName = values["app-name"] ?? report.build.appName ?? "REPLACE_WITH_APP_NAME";
  const scheme = values.scheme ?? report.build.scheme ?? appName;
  const bundleId = values["bundle-id"] ?? report.build.bundleId ?? null;
  const device = values.device ?? `Greenroom QA ${appName === "REPLACE_WITH_APP_NAME" ? "" : appName}`.trim();
  // Public SDK keys exported in prepare: --sdk-keys NAME,NAME, or the
  // public-looking keys the build reads (never a private-looking one).
  const sdkKeys = values["sdk-keys"] ? list(values["sdk-keys"]) : [];
  for (const key of sdkKeys) if (!/^[A-Z][A-Z0-9_]*$/.test(key) || (PRIVATE_KEY_NAME.test(key) && !PUBLIC_SDK_KEY_NAME.test(key))) throw new Error(`--sdk-keys ${key} is not the NAME of a public SDK key variable (a private credential never goes in prepare)`);
  const backendHost = values["backend-host"] ?? backendHostOf(manifest.allowedHosts, report);
  let prepare = null; let artifactPath = null;
  if (platform === "ios") {
    prepare = report.build.hasBuildSimulatorScript ? null : iosPrepare({ ...report, framework }, { appName, scheme, projectRoot, sdkKeys });
    artifactPath = `build/${appName}.app`;
  } else artifactPath = framework === "next" ? ".next" : report.build.outputDir ?? "dist";
  const workflow = workflowYaml({ uses: pin.uses, platform, framework: platform === "web" ? (framework === "next" ? "next" : "vite") : "custom", projectRoot, slug, bundleId, appName, device, allowedHosts: platform === "ios" ? manifest.allowedHosts : null, prepare, artifactPath, auth });

  const out = path.resolve(values.out);
  fs.mkdirSync(out, { recursive: true });
  const written = [];
  for (const [key, file] of Object.entries(FILES)) {
    const target = path.join(out, file);
    if (exists(target) && !values.overwrite) throw new Error(`${target} exists; drafts never overwrite an existing setup (pass --overwrite to replace a draft you made)`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const text = key === "workflow" ? workflow : JSON.stringify(key === "environment" ? manifest : contract, null, 2);
    fs.writeFileSync(target, `${text}\n`);
    written.push(posix(path.relative(out, target)));
  }
  return { out, written, pin, platform, framework, slug, auth, manifest, contract, omitted, backendHost, sdkKeys, inPlace: out === path.resolve(root), report };
}

// The backend the session refreshes against: --backend-host, else the first
// allowed host that is neither an SDK host nor a CDN. Never simply the first
// allowed host (the Suelto cold run named its media CDN as the backend).
export function backendHostOf(allowedHosts, report) {
  const sdkHosts = new Set((report?.hosts?.sdk ?? []).flatMap((entry) => entry.hosts).map((host) => host.toLowerCase()));
  const backendKeyHosts = new Set((report?.hosts?.configHosts ?? []).filter((entry) => /(API|BACKEND|SERVER)_?(URL|HOST|ENDPOINT|BASE)/.test(entry.from)).map((entry) => entry.host.toLowerCase()));
  const hosts = allowedHosts ?? [];
  return hosts.find((host) => backendKeyHosts.has(host.toLowerCase()))
    ?? hosts.find((host) => !sdkHosts.has(host.toLowerCase()) && !/^(cdn|media|static|assets|img|images|files|fonts)\./i.test(host) && !/^(127\.0\.0\.1|localhost)$/.test(host) && !LINK_ONLY_HOSTS.test(host))
    ?? hosts[0] ?? null;
}

// ------------------------------------------------------------------- check
// Standalone equivalents of EnvironmentAttestationSchema and
// RouteStateContractSchema (packages/production/src/contracts.js), plus the
// workflow and cross-file checks setup preflight makes. Inside the Greenroom
// repository the real preflight runs and these add only the skill's own rules.
function validateManifest(value, issues) {
  const issue = (message) => issues.push({ file: FILES.environment, message });
  if (!isObject(value)) return issue("must be a JSON object");
  const allowed = ["schemaVersion", "classification", "isolated", "resetStrategy", "networkControl", "allowedHosts", "productionHosts", "sandboxPurchases", "notes", "auth"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(`unknown field ${key} (the manifest is strict)`);
  if (value.schemaVersion !== "1.0") issue("schemaVersion must be \"1.0\"");
  if (!["preview", "staging", "test"].includes(value.classification)) issue("classification must be preview, staging or test");
  if (value.isolated !== true) issue("isolated must be the literal true");
  if (!["fresh_install", "test_hook", "ephemeral_deployment"].includes(value.resetStrategy)) issue("resetStrategy must be fresh_install, test_hook or ephemeral_deployment");
  if (!["playwright", "external_proxy", "sandboxed_backend"].includes(value.networkControl)) issue("networkControl must be playwright, external_proxy or sandboxed_backend");
  const hosts = Array.isArray(value.allowedHosts) ? value.allowedHosts : [];
  if (!Array.isArray(value.allowedHosts) || hosts.length < 1 || hosts.length > 50 || hosts.some((host) => typeof host !== "string" || !host || host.length > 253)) issue("allowedHosts must list 1 to 50 host names");
  const production = Array.isArray(value.productionHosts) ? value.productionHosts : value.productionHosts === undefined ? [] : null;
  if (production === null || production.length > 50 || production.some((host) => typeof host !== "string" || !host)) issue("productionHosts must be an array of up to 50 host names");
  const productionSet = new Set((production ?? []).map((host) => String(host).toLowerCase()));
  for (const host of hosts) if (productionSet.has(String(host).toLowerCase())) issue(`allowedHosts: production host ${host} cannot be allowlisted`);
  if (value.sandboxPurchases !== undefined && typeof value.sandboxPurchases !== "boolean") issue("sandboxPurchases must be a boolean");
  if (value.notes !== undefined && (typeof value.notes !== "string" || value.notes.length > 1000)) issue("notes must be a string of at most 1000 characters");
  const auth = value.auth ?? { mechanism: "signed_out" };
  if (!isObject(auth)) issue("auth must be an object");
  else if (auth.mechanism === "signed_out") { if (Object.keys(auth).length !== 1) issue("auth: signed_out takes no other field"); }
  else if (auth.mechanism === "session_import") {
    for (const key of Object.keys(auth)) if (!["mechanism", "secret", "target", "reset"].includes(key)) issue(`auth: unknown field ${key}`);
    if (typeof auth.secret !== "string" || !SECRET_NAME.test(auth.secret)) issue("auth.secret must be an environment-variable style secret NAME (A-Z, 0-9, _), never a value");
    if (auth.reset !== "fresh_install") issue("auth.reset must be fresh_install");
    if (value.resetStrategy !== "fresh_install") issue("auth.reset: session import requires resetStrategy fresh_install");
    const target = auth.target;
    if (!isObject(target)) issue("auth.target must declare kind, service and accounts");
    else {
      for (const key of Object.keys(target)) if (!["kind", "service", "accounts", "accessGroup"].includes(key)) issue(`auth.target: unknown field ${key}`);
      if (!["expo-secure-store", "keychain"].includes(target.kind)) issue("auth.target.kind must be expo-secure-store or keychain");
      if (typeof target.service !== "string" || !target.service || target.service.length > 200) issue("auth.target.service must be the Keychain service name");
      if (!Array.isArray(target.accounts) || !target.accounts.length || target.accounts.length > 8 || target.accounts.some((account) => typeof account !== "string" || !account || account.length > 200)) issue("auth.target.accounts must list 1 to 8 account keys");
      else if (new Set(target.accounts).size !== target.accounts.length) issue("auth.target.accounts must be unique");
      if (target.accessGroup !== undefined && (typeof target.accessGroup !== "string" || !target.accessGroup)) issue("auth.target.accessGroup must be a Keychain access group name");
    }
  } else issue("auth.mechanism must be signed_out or session_import");
  return value;
}

function validateContract(value, issues) {
  const issue = (message) => issues.push({ file: FILES.contract, message });
  if (!isObject(value)) return issue("must be a JSON object");
  const allowed = ["schemaVersion", "fixture", "entryState", "routerKind", "graphPaths", "sharedSources", "states", "transitions"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(`unknown field ${key} (the contract is strict)`);
  if (typeof value.schemaVersion !== "string" || !value.schemaVersion) issue("schemaVersion must be a string");
  if ((value.routerKind == null) !== (value.graphPaths == null)) issue("routerKind and graphPaths must be declared together");
  if (value.routerKind != null && !["hash-spa", "expo-router", "react-navigation", "swiftui"].includes(value.routerKind)) issue("routerKind must be hash-spa, expo-router, react-navigation or swiftui");
  if (value.graphPaths != null && (!Array.isArray(value.graphPaths) || !value.graphPaths.length || value.graphPaths.length > 20)) issue("graphPaths must list 1 to 20 paths");
  if (["hash-spa", "react-navigation"].includes(value.routerKind) && value.graphPaths?.length !== 1) issue(`graphPaths: routerKind ${value.routerKind} takes exactly one graph path (a single source file)`);
  if (value.sharedSources !== undefined && (!Array.isArray(value.sharedSources) || value.sharedSources.length > 100 || value.sharedSources.some((glob) => typeof glob !== "string" || !glob))) issue("sharedSources must be an array of up to 100 globs");
  if (!Array.isArray(value.states) || !value.states.length || value.states.length > 20) issue("states must list 1 to 20 states");
  for (const state of Array.isArray(value.states) ? value.states : []) {
    if (!isObject(state)) { issue("states: every entry must be an object"); continue; }
    for (const key of Object.keys(state)) if (!["id", "route", "screen", "variant", "goal", "identity", "oracle", "setupTransitions", "sources"].includes(key)) issue(`state ${state.id ?? "?"}: unknown field ${key}`);
    if (typeof state.id !== "string" || !state.id || state.id.length > 240) issue("states: id is required");
    if (state.identity !== undefined && !isObject(state.identity)) issue(`state ${state.id}: identity must be an object`);
    if (state.sources !== undefined && (!Array.isArray(state.sources) || state.sources.length > 50 || state.sources.some((glob) => typeof glob !== "string" || !glob))) issue(`state ${state.id}: sources must be an array of up to 50 globs`);
    if (state.goal !== undefined && (typeof state.goal !== "string" || state.goal.length > 2000)) issue(`state ${state.id}: goal must be a string of at most 2000 characters`);
  }
  if (value.transitions !== undefined && !Array.isArray(value.transitions)) issue("transitions must be an array");
  for (const edge of Array.isArray(value.transitions) ? value.transitions : []) {
    if (!isObject(edge) || typeof edge.id !== "string" || typeof edge.from !== "string" || typeof edge.to !== "string") { issue("transitions: every entry needs id, from and to"); continue; }
    for (const key of Object.keys(edge)) if (!["id", "from", "to", "action", "actions", "preconditions"].includes(key)) issue(`transition ${edge.id}: unknown field ${key}`);
  }
  return value;
}

function authenticatedStartClaims(contract) {
  return (Array.isArray(contract?.states) ? contract.states : []).filter((state) => { const identity = isObject(state?.identity) ? state.identity : {}; return identity.authenticated === true || /^session[-_](injection|import)$/i.test(String(identity.rung ?? "")); }).map((state) => String(state.id));
}

// The workflow, read without a YAML parser: the drafted shape is one job
// with `uses:` and a `with:` block of `key: value` lines.
function readWorkflow(text) {
  const uses = text.match(/^\s*uses:\s*(\S+\/pass\.yml@([^\s]+))\s*$/m);
  const withValue = (key) => text.match(new RegExp(`^\\s+${escapeRegExp(key)}:\\s*(.+?)\\s*$`, "m"))?.[1]?.replace(/^["']|["']$/g, "") ?? null;
  const secretsBlock = text.match(/^\s*secrets:\s*\n((?:\s+\S.*\n?)+)/m)?.[1] ?? "";
  const session = secretsBlock.match(/^\s+session:\s*(.+?)\s*$/m)?.[1] ?? null;
  const prepare = text.match(/^\s+prepare:\s*\|\s*\n((?:[ \t]+.*\n?|\n)+?)(?=^\s{6}\S|\s*$)/m)?.[1] ?? text.match(/^\s+prepare:\s*(.+)$/m)?.[1] ?? "";
  return { uses: uses?.[1] ?? null, sha: uses?.[2] ?? null, platform: withValue("platform"), appId: withValue("app-id"), allowedHosts: withValue("allowed-hosts"), artifactPath: withValue("artifact-path"), targetUrl: withValue("target-url"), sessionSecret: session, prepare };
}

export async function check(directory, values) {
  directory = path.resolve(directory);
  const repo = await loadRepoModules();
  const issues = [];
  const files = walk(directory);
  const read = (file) => { const text = readText(path.join(directory, file)); if (text === null) issues.push({ file, message: "File is missing." }); return text; };
  const workflowText = read(FILES.workflow);
  const manifestText = read(FILES.environment);
  const contractText = read(FILES.contract);
  let manifest = null; let contract = null;
  const parse = (text, file) => { if (text === null) return null; try { return JSON.parse(text); } catch (error) { issues.push({ file, message: `Invalid JSON: ${error.message}` }); return null; } };
  const manifestRaw = parse(manifestText, FILES.environment);
  const contractRaw = parse(contractText, FILES.contract);
  let mode = "standalone";
  if (repo?.preflightSetup) {
    mode = "greenroom-repo-preflight";
    const result = repo.preflightSetup({ directory });
    // The preflight's one generic placeholder sentence is replaced by the
    // named placeholders and example values below.
    issues.push(...result.issues.filter((issue) => !/^Replace the example bundle, artifact, backend, and build settings/.test(issue.message)));
    manifest = manifestRaw; contract = contractRaw;
  } else {
    if (manifestRaw !== null) manifest = validateManifest(manifestRaw, issues);
    if (contractRaw !== null) contract = validateContract(contractRaw, issues);
    if (workflowText !== null) {
      const workflow = readWorkflow(workflowText);
      const issue = (message) => issues.push({ file: FILES.workflow, message });
      if (!workflow.uses) issue("A job must call Greenroom's reusable workflow: uses: justindc100/greenroom-action/.github/workflows/pass.yml@<40-char SHA>.");
      else if (!workflow.uses.startsWith(`${WORKFLOW_PATH}@`) || !/^[a-f0-9]{40}$/.test(workflow.sha)) issue(`uses: must be ${WORKFLOW_PATH}@<40-char commit SHA>.`);
      if (!workflow.appId) issue("required reusable workflow input app-id is missing.");
      if (!["web", "ios"].includes(workflow.platform)) issue("platform must be web or ios.");
      // Placeholders and example values are named individually below, in both modes.
      if (workflow.platform === "web" && !workflow.targetUrl) issue("web: target-url is required.");
      if (manifest) {
        if (workflow.platform === "web" && manifest.networkControl !== "playwright") issues.push({ file: FILES.environment, message: "Web previews require Playwright network containment." });
        if (workflow.platform === "ios" && !["sandboxed_backend", "external_proxy"].includes(manifest.networkControl)) issues.push({ file: FILES.environment, message: "iOS needs an attested sandboxed backend or external egress proxy." });
        if (workflow.platform === "ios" && manifest.resetStrategy !== "fresh_install") issues.push({ file: FILES.environment, message: "iOS requires resetStrategy fresh_install." });
      }
      // CocoaPods lockfile drift (the Suelto pilot's first hosted failure), as setup preflight names it.
      const lockfile = files.find((file) => file === "ios/Podfile.lock") ?? files.find((file) => /(^|\/)Podfile\.lock$/.test(file));
      const lockVersion = lockfile ? readText(path.join(directory, lockfile))?.match(/^COCOAPODS:\s*(\d+\.\d+\.\d+)\s*$/m)?.[1] ?? null : null;
      if (workflow.platform === "ios" && lockVersion) {
        const prepareCode = stripShellComments(workflow.prepare);
        const scripts = [...prepareCode.matchAll(/(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.(?:sh|bash|py|rb|mjs|js))(?![\w./-])/g)].map((match) => readText(path.join(directory, match[1].replace(/^(?:\.\/)+/, ""))) ?? "");
        const corpus = [prepareCode, ...scripts].join("\n");
        const gemfileLock = files.find((file) => /(^|\/)Gemfile\.lock$/.test(file));
        const pinned = corpus.match(/gem install cocoapods\b[^\n]*?(?:-v|--version)[ =]+(\d+\.\d+\.\d+)/)?.[1] ?? corpus.match(/\bpod _(\d+\.\d+\.\d+)_/)?.[1] ?? (gemfileLock ? readText(path.join(directory, gemfileLock))?.match(/^\s+cocoapods \((\d+\.\d+\.\d+)\)/m)?.[1] : null) ?? null;
        if (pinned && pinned !== lockVersion) issues.push({ file: lockfile, code: "cocoapods-lockfile-drift", message: `cocoapods-lockfile-drift: ${lockfile} was written by CocoaPods ${lockVersion} but the build pins ${pinned}.` });
        else if (!pinned && lockVersion !== "1.17.0") issues.push({ file: lockfile, code: "cocoapods-lockfile-drift", message: `cocoapods-lockfile-drift: ${lockfile} was written by CocoaPods ${lockVersion}; the macos-26 image ships 1.17.0, which refuses a lockfile from another version, and nothing in prepare pins one. Add \`sudo gem install cocoapods -v ${lockVersion}\` and \`pod _${lockVersion}_ install\`.` });
      }
      for (const match of workflow.prepare.matchAll(/\bbrew\s+--prefix\s+([\w@.+-]+)/g)) if (!new RegExp(`brew\\s+(?:install|list)\\b[^\\n]*\\b${escapeRegExp(match[1].split("@")[0])}`).test(workflow.prepare)) issues.push({ file: FILES.workflow, code: "brew-formula-not-installed", message: `brew-formula-not-installed: prepare locates ${match[1]} with brew --prefix but never installs it.` });
    }
    if (manifest && /example\.(test|com)/.test(JSON.stringify(manifest))) issues.push({ file: FILES.environment, code: "example-value", message: `Example hosts remain (${uniq([...JSON.stringify(manifest).matchAll(/[a-z0-9.-]*example\.(?:test|com)/g)].map((match) => match[0])).join(", ")}); declare only the actual isolated preview and its dependencies.` });
    if (contract && Array.isArray(contract.states)) {
      const ids = new Set(contract.states.map((state) => state.id));
      if (contract.entryState && !ids.has(contract.entryState)) issues.push({ file: FILES.contract, message: "Entry state is not declared." });
      for (const state of contract.states) {
        if (!state.goal || !state.sources?.length) issues.push({ file: FILES.contract, message: `${state.id} needs an observable goal and source mappings for reliable scoping.` });
        else if (!state.sources.some((pattern) => files.some((file) => matchesGlob(file, pattern)))) issues.push({ file: FILES.contract, message: `${state.id}: none of the declared source patterns matches a file. Replace the example mappings.` });
      }
      for (const edge of contract.transitions ?? []) if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push({ file: FILES.contract, message: `Transition ${edge.id} references an unknown state.` });
    }
  }
  // The skill's own rules, in both modes.
  if (workflowText !== null) {
    const workflow = readWorkflow(workflowText);
    // Shell comments are not build settings: a comment that says "never add
    // CODE_SIGNING_ALLOWED=NO" must not trip the unsigned-build rule.
    const prepareCode = stripShellComments(workflow.prepare);
    const expected = values.pin ? String(values.pin).replace(/^.*@/, "") : repo?.PASS_WORKFLOW_USES ? repo.PASS_WORKFLOW_USES.split("@")[1] : values.offline ? null : await fetchStablePin({ platform: workflow.platform ?? "web" }).then((pin) => pin.sha).catch(() => null);
    // Placeholders, each named with its count, so the message says exactly what is left.
    namePlaceholders(workflowText, FILES.workflow, issues);
    for (const example of ["api.example.test", "com.example.app", "REPLACE_WITH_APP_NAME"]) if (workflowText.includes(example) && !/^REPLACE_WITH/.test(example)) issues.push({ file: FILES.workflow, code: "example-value", message: `The example value ${example} is still in the workflow; replace it with this app's own.` });
    if (workflow.platform === "ios" && prepareCode) {
      // CocoaPods: never an unpinned `pod install` (the hosted image resolves
      // pods with its own CocoaPods, differently from the owner's machine and
      // from run to run); and a lockfile the prepare block copies must exist.
      if (/(^|[;&|]\s*|\n\s*)pod\s+install\b/.test(prepareCode) && !/\bpod\s+_\d+\.\d+\.\d+_\s+install\b/.test(prepareCode)) issues.push({ file: FILES.workflow, code: "cocoapods-unpinned", message: "prepare runs an unpinned `pod install`. Track a Podfile.lock (produce it once locally: `npx expo prebuild --platform ios --no-install && pod install --project-directory=ios`, then copy ios/Podfile.lock to .greenroom/Podfile.lock and commit it), copy it into ios/ in prepare, and pin CocoaPods to its COCOAPODS: version (`sudo gem install cocoapods -v X.Y.Z` and `pod _X.Y.Z_ install --project-directory=ios --deployment`)." });
      for (const match of prepareCode.matchAll(/\bcp\s+(\S*Podfile\.lock)\s+\S+/g)) if (!exists(path.join(directory, match[1].replace(/^(?:\.\/)+/, "")))) issues.push({ file: FILES.workflow, code: "podfile-lock-missing", message: `prepare copies ${match[1]} but that file does not exist in the tree. Produce it locally (prebuild, then pod install), copy it to that path and commit it.` });
      // prepare runs with no credentials: it cannot receive a repository
      // secret, and a private key pasted into it is exposed to anyone who
      // can read the repository.
      if (/\$\{\{\s*secrets\./.test(workflow.prepare)) issues.push({ file: FILES.workflow, code: "private-key-in-prepare", message: "prepare references the secrets context; a reusable workflow's inputs cannot carry repository secrets, and prepare must never handle a private key. Public SDK keys go through a GitHub Actions variable (vars.NAME); the session goes through secrets.session only." });
      for (const match of prepareCode.matchAll(/\bexport\s+([A-Z][A-Z0-9_]*)=("?)([^\s"]+)\2/g)) {
        const [, name, , value] = match;
        if (/REPLACE_WITH|\$\{\{\s*vars\.|^\$/.test(value)) continue;
        const privateValue = /^(sk_(live|test)_|rk_live_|AKIA[0-9A-Z]{16}|ghp_|github_pat_|xox[abp]-|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/.test(value);
        if (privateValue || (PRIVATE_KEY_NAME.test(name) && !PUBLIC_SDK_KEY_NAME.test(name) && !/^(true|false|\d+|[A-Za-z]+)$/.test(value))) issues.push({ file: FILES.workflow, code: "private-key-in-prepare", message: `prepare exports ${name} with a value that looks like a private credential. Only a TEST project's PUBLIC SDK key may be exported here (through vars.NAME); remove it and rotate it if it was real.` });
      }
    }
    if (expected && workflow.sha && workflow.sha !== expected) issues.push({ file: FILES.workflow, message: `uses: pins ${workflow.sha} but the current stable pin is ${expected}; update the pin.` });
    if (!expected && !values.offline) issues.push({ file: FILES.workflow, message: "The pin could not be verified against the public docs; confirm it equals the quickstart's uses: line." });
    if (manifest?.allowedHosts && workflow.platform === "ios") {
      const declared = list(workflow.allowedHosts ?? "").sort().join(",");
      if (declared && declared !== [...manifest.allowedHosts].sort().join(",")) issues.push({ file: FILES.workflow, message: `allowed-hosts (${declared}) must equal the manifest's allowedHosts (${manifest.allowedHosts.join(",")}).` });
    }
    const mechanism = manifest?.auth?.mechanism ?? "signed_out";
    if (mechanism === "session_import" && !workflow.sessionSecret) issues.push({ file: FILES.workflow, message: `The manifest declares session_import but the job passes no session secret. Add:\n    secrets:\n      session: \${{ secrets.${manifest.auth.secret ?? "GREENROOM_SESSION"} }}` });
    if (mechanism === "session_import" && workflow.sessionSecret && manifest?.auth?.secret && !workflow.sessionSecret.includes(`secrets.${manifest.auth.secret}`)) issues.push({ file: FILES.workflow, message: `secrets.session reads ${workflow.sessionSecret} but the manifest names the secret ${manifest.auth.secret}.` });
    if (mechanism === "signed_out" && workflow.sessionSecret) issues.push({ file: FILES.workflow, message: "The job passes a session secret but the manifest is signed_out; declare auth.mechanism session_import or drop secrets.session." });
    if (mechanism === "session_import" && workflow.platform !== "ios") issues.push({ file: FILES.environment, message: "session import is supported for iOS runs only." });
    if (mechanism === "session_import" && /CODE_SIGNING_ALLOWED\s*=\s*NO/.test(prepareCode)) issues.push({ file: FILES.workflow, message: "CODE_SIGNING_ALLOWED=NO produces an unsigned simulator build, which cannot use the Keychain; a session import needs an ad-hoc signed build." });
    const claims = authenticatedStartClaims(contract);
    if (claims.length && mechanism !== "session_import") issues.push({ file: FILES.environment, message: `state contract claims an authenticated start for ${claims.slice(0, 5).join(", ")} but the environment manifest declares no session import mechanism (auth.mechanism).` });
    if (mechanism === "session_import" && !claims.length) issues.push({ file: FILES.contract, message: "The manifest imports a session but no state declares identity.authenticated: true; mark the signed-in screens." });
  }
  if (manifestText !== null) namePlaceholders(manifestText, FILES.environment, issues);
  if (contractText !== null && /REPLACE with/.test(contractText)) {
    const states = (Array.isArray(contractRaw?.states) ? contractRaw.states : []).filter((state) => /REPLACE with/.test(String(state?.goal ?? ""))).map((state) => state.id);
    issues.push({ file: FILES.contract, code: "owner-placeholder", message: `Rewrite the drafted goals as observable outcomes; ${states.length} state(s) still carry the drafted "REPLACE with" goal: ${states.slice(0, 20).join(", ")}.` });
  }
  const importPaths = findImportPaths(directory, ".", files).filter((finding) => !finding.file.startsWith(".greenroom/"));
  if ((manifest?.auth?.mechanism ?? "signed_out") === "session_import") for (const finding of importPaths) issues.push({ file: finding.file, code: finding.code, message: `possible in-app session import path (${finding.code}, line ${finding.line}): ${finding.why}. Remove it; Greenroom writes the Keychain from outside the app. ${finding.excerpt}` });
  // ready=false with only owner placeholders left is the expected end of a
  // non-interactive run: the values are the owner's decisions, not the agent's.
  const readyExceptPlaceholders = issues.length > 0 && issues.every((issue) => issue.code === "owner-placeholder");
  return { ready: issues.length === 0, readyExceptPlaceholders, mode, checkedRevision: "working-tree", issues, importPaths, remainingChecks: ["Build and launch the isolated preview in CI.", "Verify allowed hosts against actual network requests.", "Confirm the declared screens and goals match the app.", "Complete a real PR pass and inspect its evidence and GitHub Check."] };
}

// `# comment` lines and trailing ` # comments` removed; a `#` inside a
// word or a URL (`$RUNNER_TEMP`, `https://x/#y`) is not a comment.
export function stripShellComments(text) {
  return String(text ?? "").split("\n").map((line) => line.replace(/^\s*#.*$/, "").replace(/\s+#.*$/, "")).join("\n");
}

// Each REPLACE_WITH_* token by name and count, so the check says exactly
// which placeholder is left rather than "replace the example settings".
function namePlaceholders(text, file, issues) {
  const counts = new Map();
  for (const match of text.matchAll(/REPLACE_WITH(?:_[A-Z0-9]+)+(?![A-Z0-9])/g)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  if (!counts.size) return;
  const listed = [...counts.entries()].map(([token, count]) => `${token}${count > 1 ? ` (${count} occurrences)` : ""}`).join(", ");
  issues.push({ file, code: "owner-placeholder", message: `Placeholder${counts.size > 1 ? "s" : ""} still to resolve in ${file}: ${listed}. Each is a value only the owner can decide (the isolated backend, a test-project public key, the lockfile's CocoaPods version).` });
}

// ------------------------------------------------------------- checklist
export function ownerChecklist({ platform, auth, manifest, slug, backendHost = null, sdkKeys = [] }) {
  const items = [];
  const host = backendHost ?? backendHostOf(manifest.allowedHosts, null);
  const hostText = !host || /REPLACE_WITH/.test(host) ? "the isolated backend host (still to be decided; it replaces the REPLACE_WITH placeholder in allowedHosts and in prepare)" : `the isolated backend ${host} (the host the app's session refreshes against; it is in allowedHosts)`;
  if (auth?.mechanism === "session_import") {
    items.push(`Create a disposable account on ${hostText}; synthetic data only, minimal role, never a production or personal account.`);
    items.push(`Issue a session for it with the backend's normal session issuer (the same function or endpoint sign-in calls) and store the JSON object {${auth.target.accounts.map((account) => `"${account}": "…"`).join(", ")}} as the repository secret ${auth.secret}. Never paste the value into a file, a PR, a chat or a workflow input.`);
    items.push("Keep the session long enough for a 45-minute job (a refresh token, not a short-lived access token); rotate on a schedule and immediately if it was ever printed.");
    items.push("If the backend rotates refresh tokens (single use, family revocation), the stored secret works for exactly one pass: either reissue it before every pass, or let the isolated backend (not the app) allow reuse for this one synthetic account; per-pass issuance from prepare is available from the runner release after 0.3.16.");
  }
  if (sdkKeys.length) items.push(`Provide a TEST project's PUBLIC key for ${sdkKeys.join(", ")} (a GitHub Actions variable keeps it out of Git; a private key never goes in prepare), or guard the SDK in a test build so the app starts without it.`);
  items.push("Install the Greenroom GitHub App on this repository (read-only): https://github.com/apps/greenroom-virtual-user/installations/new");
  items.push(`Connect the repository in Greenroom and name the app "${slug}" (the app-id in the workflow).`);
  items.push("Review the diff, then merge the three setup files into the base branch FIRST: policy is read from the base revision, so a pull request cannot start a pass until they are there.");
  items.push("Open a separate test pull request that changes a mapped screen; the Check on that PR links the report. The first pass finds the hosts you forgot: an off-allowlist request ends the walk with the host named, and the fix is completing allowedHosts, not widening policy.");
  items.push("Cost: every workspace gets 20 free screen checks; after that a plan is required (pay-as-you-go $49/month plus $1.50 per screen check, Team $349/month with 400 included, Scale $999/month with 1,500 included; https://docs.getgreenroom.io/docs/pricing). Only judged screens are charged, and a pass is bounded at 20 screen checks and 10 minutes by default.");
  if (platform === "ios") items.push("Hosted macOS preparation (simulator boot, runner build) is measured at several minutes; keep the job's 45-minute limit and cache Pods/DerivedData in a separate build job if the build itself is slow.");
  return items;
}

// -------------------------------------------------------------------- main
function printReport(report) {
  const lines = [];
  lines.push(`Project: ${report.root}${report.projectRoot === "." ? "" : ` (project root ${report.projectRoot})`}`);
  lines.push(`Framework: ${report.framework} -> platform ${report.platform}; suggested app-id ${report.suggestedSlug}`);
  lines.push(`Router: ${report.router.routerKind ?? "none detected"}${report.router.graphPaths ? ` (graphPaths ${report.router.graphPaths.join(", ")})` : ""}; ${report.router.routes.length} route(s); each route's sources are the files it reaches through imports`);
  for (const route of report.router.routes.slice(0, 40)) lines.push(`  ${route.id}  <- ${route.file}${route.redirectOnly ? "  (redirect only: not a screen, listed in sharedSources)" : ""}${route.authenticated === "inferred" ? "  (reachable only from gated screens: authenticated start inferred; confirm)" : ""}; sources: ${route.sources.length} file(s)${route.sources.length > 1 ? ` (${route.sources.slice(1, 4).join(", ")}${route.sources.length > 4 ? ", …" : ""})` : ""}`);
  if (report.router.routes.length > 40) lines.push(`  … ${report.router.routes.length - 40} more`);
  lines.push(`Shared sources (layouts, redirect-only routes, and what EVERY screen imports): ${report.sharedSources.join(", ") || "none found; name the layouts and the files every screen imports"}`);
  lines.push(`Build: ${report.build.appName ?? "?"} bundle ${report.build.bundleId ?? "?"}; ${report.build.xcworkspace ?? report.build.xcodeproj ?? "no Xcode project in the tree"}${report.build.iosIgnored ? " (ios/ is gitignored: prebuild in CI)" : ""}; CocoaPods lockfile ${report.build.lockfile ?? "none"}${report.build.cocoapodsVersion ? ` (${report.build.cocoapodsVersion})` : ""}${report.build.sentry ? "; Sentry present (disable source-map upload)" : ""}`);
  lines.push("Hosts found in source (decide allowedHosts from what the TEST build contacts; the rest go to productionHosts):");
  for (const entry of report.hosts.literal) lines.push(`  ${entry.kind.padEnd(16)} ${entry.host}  (${entry.count} file(s): ${entry.files.slice(0, 2).join(", ")})`);
  for (const entry of report.hosts.sdk) lines.push(`  sdk              ${entry.hosts.join(", ")}  via ${entry.dependency}: ${entry.note}`);
  for (const entry of report.hosts.envKeys) lines.push(`  build-time       process.env.${entry.key}  (${entry.files[0]}): the host it names at build time must be listed`);
  for (const entry of report.hosts.configHosts) lines.push(`  config           ${entry.host}  from ${entry.from}`);
  const candidates = candidateSdkKeys(report.hosts.sdkKeys ?? [], report.platform);
  if (candidates.length) lines.push(`  sdk-keys         ${candidates.join(", ")}: public SDK keys the build reads (one per family; ${report.hosts.sdkKeys.length} variables in all). If an SDK refuses to start without its key, draft with --sdk-keys NAME so prepare exports a TEST project's public key; a private key never goes in prepare.`);
  for (const entry of (report.hosts.sdkKeys ?? []).filter((item) => item.kind !== "public-sdk-key").slice(0, 8)) lines.push(`  key-variable     process.env.${entry.key}  (${entry.files[0]}): ${entry.kind === "private-looking" ? "looks private: never in prepare; the test build must work without it" : "decide whether it is a public SDK key (allowed in prepare, test project only) or a credential (never)"}`);
  lines.push(`Auth: ${report.auth.wall ? "sign-in wall detected" : "no sign-in wall detected"}${report.auth.kind ? `; storage ${report.auth.kind} service ${report.auth.service}` : ""}${report.auth.accounts.length ? `; keys ${report.auth.accounts.join(", ")}` : ""}${report.auth.gatedDirs.length ? `; gated layouts ${report.auth.gatedDirs.map((dir) => dir || "(root)").join(", ")}` : ""}${report.auth.providers.length ? `; providers ${report.auth.providers.join(", ")}` : ""}${report.auth.requireAuthentication ? "; WARNING requireAuthentication items cannot be imported" : ""}`);
  for (const signal of report.auth.signals) lines.push(`  ${signal.file}: ${signal.signal}`);
  lines.push(`In-app session import paths to remove (${report.importPaths.length}):`);
  for (const finding of report.importPaths) lines.push(`  ${finding.file}:${finding.line} ${finding.code}: ${finding.excerpt}`);
  lines.push(`Existing setup: ${Object.entries(report.existing).filter(([, present]) => present).map(([key]) => FILES[key]).join(", ") || "none"}`);
  return lines.join("\n");
}

async function main() {
  const { values, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || values.help) {
    console.log("Usage: greenroom-onboard.mjs detect [DIR] [--json] | pin [--platform web|ios] | draft [DIR] --out DIR --app SLUG [--pin SHA] [--auth signed_out|session_import] [--secret NAME] [--accounts a,b] [--service S] [--target-kind expo-secure-store|keychain] [--allowed-hosts h1,h2] [--production-hosts h1,h2] [--backend-host HOST] [--sdk-keys ENV_NAME,ENV_NAME] [--bundle-id ID] [--app-name NAME] [--scheme S] [--device NAME] [--exclude route,route*] [--authenticated route,route*] [--entry route] [--platform web|ios] [--framework F] [--root DIR] [--sandbox-purchases true] [--offline] [--overwrite] | check DIR [--pin SHA] [--offline] [--json]");
    return;
  }
  if (command === "detect") {
    const report = detect(positional[1] ?? process.cwd(), { projectRoot: values.root ?? null });
    console.log(values.json ? JSON.stringify(report, null, 2) : printReport(report));
    return;
  }
  if (command === "pin") {
    const pin = await fetchStablePin({ platform: values.platform ?? "web", docsUrl: values["docs-url"] ?? null });
    pin.release = await releaseNameOf(pin.sha);
    console.log(values.json ? JSON.stringify(pin) : `uses: ${pin.uses}\n(read from ${pin.source})\nrelease: ${pin.release}`);
    return;
  }
  if (command === "draft") {
    if (!values.out) throw new Error("--out DIR is required (a new directory, or the repository root when it has no Greenroom setup yet)");
    const result = await draft(positional[1] ?? process.cwd(), values);
    if (values.json) { console.log(JSON.stringify({ ...result, report: undefined }, null, 2)); return; }
    console.log(`Drafted ${result.written.join(", ")} under ${result.out} for ${result.platform}/${result.framework} app "${result.slug}" (workflow pin ${result.pin.sha} from ${result.pin.source}; auth ${result.auth.mechanism}).`);
    if (result.omitted.length) console.log(`States omitted to stay under the 20-state cap (add the important ones by hand): ${result.omitted.join(", ")}`);
    const placeholders = [];
    for (const file of result.written) { const text = readText(path.join(result.out, file)) ?? ""; for (const match of uniq([...text.matchAll(/REPLACE_WITH(?:_[A-Z0-9]+)+(?![A-Z0-9])|REPLACE with[^."\n]*/g)].map((m) => m[0]))) placeholders.push(`${file}: ${match}`); }
    if (placeholders.length) console.log(`Placeholders to resolve before the check passes:\n  ${placeholders.join("\n  ")}`);
    console.log("\nOwner checklist (only the repository owner can do these):");
    for (const [index, item] of ownerChecklist(result).entries()) console.log(`  ${index + 1}. ${item}`);
    if (!result.inPlace) console.log(`\nCopy the three files from ${result.out} into the repository root, then delete ${result.out}; it must not be left in the working tree. (Re-run with --out . to draft in place when the repository has no Greenroom setup yet.)`);
    console.log("\nNo repository file outside --out was changed; nothing was committed, pushed or uploaded; no secret value was read or written.");
    return;
  }
  if (command === "check") {
    if (!positional[1]) throw new Error("check DIR: the directory that holds .github/workflows/greenroom.yml and .greenroom/");
    const result = await check(positional[1], values);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 2; });
}
