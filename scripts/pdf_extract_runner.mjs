import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mod = require("pdf-parse");
const PDFParse = mod.PDFParse ?? mod.default?.PDFParse ?? mod.default;

async function run(paths) {
  let mergedText = "";
  for (const p of paths) {
    const data = fs.readFileSync(p);
    const parser = new PDFParse({ data });
    const result = await parser.getText();
    await parser.destroy();

    const text = String(result?.text || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    mergedText += `\n\n// --- ${p.split("/").pop()} ---\n`;
    if (text) mergedText += text + "\n";
  }
  return mergedText.trim();
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ ok: false, error: "no files" }));
  process.exit(0);
}

try {
  const text = await run(args);
  console.log(JSON.stringify({ ok: true, text }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }));
}

