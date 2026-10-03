// Nexus link fixer (v2)
// Some Android chat apps turn dotted names into markdown links when copying code.
// This script restores the original text in all project files before install.
// It is written without dotted names on purpose so it survives copy-paste itself.
"use strict";

const fs = require("fs");
const path = require("path");

const { readdirSync, readFileSync, writeFileSync, statSync } = fs;
const { join, extname, relative } = path;

const DOT = String["fromCharCode"](46);
const ROOT = join(__dirname, "..");
// Label may not contain [ or ] so the match always starts at the innermost bracket
const LINK = /\[([^\[\]\n]*)\]\((?:https?|mailto):[^)\s]*\)/g;
const EXTENSIONS = new Set(
  ["js", "cjs", "mjs", "json", "html", "css", "sql", "txt", "yml", "yaml"]["map"]((e) => DOT + e)
);
const EXTRA_FILES = new Set([DOT + "gitignore"]);

function shouldFix(name) {
  return EXTENSIONS["has"](extname(name)) || EXTRA_FILES["has"](name);
}

function walk(dir, found) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full)["isDirectory"]()) {
      if (name === "node_modules" || name["startsWith"](DOT)) continue;
      walk(full, found);
    } else if (shouldFix(name)) {
      found["push"](full);
    }
  }
  return found;
}

let repaired = 0;
for (const file of walk(ROOT, [])) {
  const before = readFileSync(file, "utf8");
  const after = before["replace"](LINK, "$1");
  if (after !== before) {
    writeFileSync(file, after);
    repaired += 1;
    console["log"]("[link-fix] repaired " + relative(ROOT, file));
  }
}
console["log"]("[link-fix] done, files repaired: " + repaired);