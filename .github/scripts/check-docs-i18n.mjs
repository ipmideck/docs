#!/usr/bin/env node
// Translation-completeness gate for the docs site.
//
// `en` is the source of truth. Checks that every language in docs.json has a
// folder (and vice versa), the same .mdx files as `en`, the same navigation
// shape, a translated title/description in every page's frontmatter, and no
// page body left identical to en.
// With `--since <rev> [--head <rev>]` it also fails when an `en` page changed
// in that range without the matching change in every other language.
//
// Usage: node .github/scripts/check-docs-i18n.mjs [--since <rev>] [--head <rev>]
// Zero dependencies; Node 20+.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = "en";
const SKIP_DIRS = new Set(["console", "tutorials", "node_modules"]);
const SKIP_TOKEN = "[i18n-skip]";
const ZERO_SHA = /^0+$/;

// Words that are legitimately identical in every language. A non-en title or
// description equal to en's is accepted only when it is built from these
// tokens alone (plus numbers and punctuation). Keep it to brands and acronyms.
const BRAND_TOKENS = new Set(
  [
    "ipmideck", "IPMIDeck", "IPMI", "BMC", "CLI", "FAQ", "API", "UI", "LAN", "SEL", "FRU",
    "Docker", "Compose", "Dell", "iDRAC", "PowerEdge", "HPE", "iLO", "ProLiant", "Lenovo",
    "XCC", "ThinkSystem", "IBM", "IMM", "Supermicro", "IPMIView", "ipmitool", "Linux",
    "Windows", "macOS", "pip", "pipx", "Python", "systemd", "TLS", "HTTPS",
  ].map((t) => t.toLowerCase()),
);

// Whole values that are the correct translation and happen to be spelled
// exactly like en (cognates). Add an entry only after confirming the word is
// right in that language -- never to silence a page that was not translated.
const COGNATES = {
  de: ["Installation"],
  fr: ["Configuration", "Installation"],
};

const failures = [];
const fail = (scope, message) => failures.push(`[${scope}] ${message}`);
const toPosix = (p) => p.split(sep).join("/");

/* --- arguments --- */

function parseArgs(argv) {
  const out = { since: undefined, head: "HEAD" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flag !== "--since" && flag !== "--head") {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      value = next !== undefined && !next.startsWith("--") ? (i++, next) : "";
    }
    if (flag === "--since") out.since = value;
    else out.head = value || "HEAD";
  }
  return out;
}

/* --- filesystem helpers --- */

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listMdx(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".mdx")) found.push(toPosix(relative(dir, full)));
    }
  };
  if (isDir(dir)) walk(dir);
  return found.sort();
}

/* --- frontmatter --- */

function unquote(raw) {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v.replace(/\s+#.*$/, "");
}

/** Frontmatter fields, plus the page body (everything after the block) as `body`. */
function readFrontmatter(file) {
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== "---") return null;
  const fields = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return { ...fields, body: lines.slice(i + 1).join("\n").trim() };
    }
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(lines[i]);
    if (m) fields[m[1]] = unquote(m[2]);
  }
  return null; // unterminated block
}

function isBrandOnly(value) {
  const tokens = value.split(/[\s/&()[\],.:;!?+|–—-]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t) || BRAND_TOKENS.has(t.toLowerCase().replace(/\d+$/, "")));
}

/* --- docs.json navigation --- */

function walkNav(node, acc) {
  if (Array.isArray(node)) {
    for (const item of node) walkNav(item, acc);
  } else if (typeof node === "string") {
    acc.pages.push(node);
  } else if (node && typeof node === "object") {
    if (typeof node.group === "string") acc.groups++;
    for (const key of ["tabs", "anchors", "dropdowns", "groups", "pages"]) {
      if (key in node) walkNav(node[key], acc);
    }
  }
  return acc;
}

/* --- checks --- */

function loadDocsJson() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "docs.json"), "utf8"));
  } catch (e) {
    fail("docs.json", `cannot read or parse docs.json: ${e.message}`);
    return null;
  }
}

function checkLanguageSet(navLangs) {
  const navSet = new Set(navLangs);
  const folders = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .filter((name) => navSet.has(name) || listMdx(join(ROOT, name)).length > 0);
  const folderSet = new Set(folders);
  for (const lang of navLangs) {
    if (!folderSet.has(lang)) fail(lang, "listed in docs.json navigation.languages but has no folder");
  }
  for (const lang of folders) {
    if (!navSet.has(lang)) fail(lang, "folder contains .mdx pages but is missing from docs.json navigation.languages");
  }
  return navLangs.filter((l) => folderSet.has(l));
}

function checkFileParity(langs, files) {
  const enFiles = new Set(files.get(SOURCE));
  for (const lang of langs) {
    if (lang === SOURCE) continue;
    const own = new Set(files.get(lang));
    for (const f of enFiles) if (!own.has(f)) fail(lang, `missing ${lang}/${f} (exists in ${SOURCE})`);
    for (const f of own) if (!enFiles.has(f)) fail(lang, `extra ${lang}/${f} (no ${SOURCE}/${f})`);
  }
}

function checkNavigation(languages) {
  const navs = new Map(languages.map((l) => [l.language, walkNav(l, { pages: [], groups: 0 })]));
  const en = navs.get(SOURCE);
  for (const [lang, nav] of navs) {
    for (const page of nav.pages) {
      if (!existsSync(join(ROOT, `${page}.mdx`))) fail(lang, `docs.json page "${page}" has no ${page}.mdx`);
    }
    if (lang === SOURCE || !en) continue;
    if (nav.groups !== en.groups) fail(lang, `docs.json has ${nav.groups} group(s), ${SOURCE} has ${en.groups}`);
    const expected = en.pages.map((p) => (p.startsWith(`${SOURCE}/`) ? `${lang}/${p.slice(SOURCE.length + 1)}` : p));
    const n = Math.max(expected.length, nav.pages.length);
    for (let i = 0; i < n; i++) {
      if (expected[i] !== nav.pages[i]) {
        fail(lang, `docs.json page #${i + 1} is "${nav.pages[i] ?? "(none)"}", expected "${expected[i] ?? "(none)"}"`);
        break; // one positional report per language is enough to locate the drift
      }
    }
    if (nav.pages.length !== expected.length) {
      fail(lang, `docs.json lists ${nav.pages.length} page(s), ${SOURCE} lists ${expected.length}`);
    }
  }
}

function checkFrontmatter(langs, files) {
  const enMeta = new Map();
  for (const lang of [SOURCE, ...langs.filter((l) => l !== SOURCE)]) {
    for (const f of files.get(lang)) {
      const fm = readFrontmatter(join(ROOT, lang, f));
      if (!fm) {
        fail(lang, `${lang}/${f} has no closed --- frontmatter block`);
        continue;
      }
      for (const key of ["title", "description"]) {
        if (!fm[key] || !fm[key].trim()) fail(lang, `${lang}/${f} has an empty or missing "${key}"`);
      }
      if (lang === SOURCE) {
        enMeta.set(f, fm);
        continue;
      }
      const src = enMeta.get(f);
      if (!src) continue;
      for (const key of ["title", "description"]) {
        const v = fm[key]?.trim();
        if (v && v === src[key]?.trim() && !isBrandOnly(v) && !COGNATES[lang]?.includes(v)) {
          fail(lang, `${lang}/${f} "${key}" is identical to ${SOURCE} (untranslated): "${v}"`);
        }
      }
      if (fm.body && fm.body === src.body) {
        fail(lang, `${lang}/${f} body is identical to ${SOURCE} (untranslated page)`);
      }
    }
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function checkStale(langs, since, head) {
  let base = null;
  if (since && !ZERO_SHA.test(since)) {
    try {
      base = git(["rev-parse", "--verify", "--quiet", `${since}^{commit}`]).trim() || null;
    } catch {
      base = null;
    }
  }
  if (!base) {
    console.log("stale check skipped (no base)");
    return;
  }
  let tip;
  try {
    tip = git(["rev-parse", "--verify", "--quiet", `${head}^{commit}`]).trim();
  } catch {
    fail("git", `cannot resolve --head "${head}"`);
    return;
  }
  const messages = git(["log", "--format=%B", `${base}..${tip}`]);
  if (messages.includes(SKIP_TOKEN)) {
    console.log(`stale check skipped (${SKIP_TOKEN} in a commit message in ${base.slice(0, 7)}..${tip.slice(0, 7)})`);
    return;
  }
  const changed = new Set(
    git(["-c", "core.quotepath=false", "diff", "--name-only", "-z", "--diff-filter=AM", base, tip])
      .split("\0")
      .filter(Boolean),
  );
  let enChanged = 0;
  for (const file of changed) {
    if (!file.startsWith(`${SOURCE}/`) || !file.endsWith(".mdx")) continue;
    enChanged++;
    const rel = file.slice(SOURCE.length + 1);
    for (const lang of langs) {
      if (lang === SOURCE || changed.has(`${lang}/${rel}`)) continue;
      fail(lang, `${rel} not updated after ${SOURCE} change (add ${SKIP_TOKEN} to a commit message to override)`);
    }
  }
  console.log(`stale check: ${enChanged} ${SOURCE} page(s) changed in ${base.slice(0, 7)}..${tip.slice(0, 7)}`);
}

/* --- main --- */

const args = parseArgs(process.argv.slice(2));
const docs = loadDocsJson();
const languages = Array.isArray(docs?.navigation?.languages) ? docs.navigation.languages : null;
if (docs && !languages) fail("docs.json", "navigation.languages is missing or not an array");

if (languages) {
  const navLangs = languages.map((l) => l.language);
  if (!navLangs.includes(SOURCE)) fail(SOURCE, "source language missing from docs.json navigation.languages");
  const langs = checkLanguageSet(navLangs);
  if (langs.includes(SOURCE)) {
    const files = new Map(langs.map((l) => [l, listMdx(join(ROOT, l))]));
    checkFileParity(langs, files);
    checkNavigation(languages);
    checkFrontmatter(langs, files);
    if (args.since !== undefined) checkStale(langs, args.since, args.head);
  }
}

if (failures.length) {
  for (const f of failures) console.error(f);
  console.error(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("i18n OK: all languages match en (files, navigation, frontmatter).");
