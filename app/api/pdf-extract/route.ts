export const runtime = "nodejs";

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function ensurePdfPolyfills() {
  const g = globalThis as any;
  if (!g.DOMMatrix) {
    const dm: any = await import("dommatrix");
    const DOMMatrixCtor = dm?.default ?? dm;
    g.DOMMatrix = DOMMatrixCtor;
    if (!g.DOMMatrixReadOnly) g.DOMMatrixReadOnly = DOMMatrixCtor;
  }
}

export async function POST(req: Request) {
  let workDir = "";
  try {
    const form = await req.formData();
    const files = form.getAll("files");

    if (!files || files.length === 0) {
      return Response.json({ ok: false, error: "PDF 파일이 없습니다." }, { status: 400 });
    }

    workDir = await fs.mkdtemp(join(tmpdir(), "atomy-pdf-"));
    const paths: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i] as File;
      const name = (f.name || `file-${i + 1}.pdf`).replace(/[^\w.\-가-힣]/g, "_");
      const p = join(workDir, `${i + 1}-${name}`);
      const ab = await f.arrayBuffer();
      await fs.writeFile(p, Buffer.from(ab));
      paths.push(p);
    }

    await ensurePdfPolyfills();
    const pdfMod: any = await import("pdf-parse");
    const PDFParse = pdfMod?.PDFParse ?? pdfMod?.default?.PDFParse ?? pdfMod?.default;
    if (!PDFParse) {
      return Response.json({ ok: false, error: "pdf-parse 로딩 실패" }, { status: 500 });
    }

    let mergedText = "";
    for (const p of paths) {
      const data = await fs.readFile(p);
      const parser = new PDFParse({ data });
      const result = await parser.getText();
      await parser.destroy();

      const text = String(result?.text || "")
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      mergedText += `\n\n// --- ${p.split("/").pop()} ---\n`;
      if (text) mergedText += `${text}\n`;
    }

    return Response.json({ ok: true, text: mergedText.trim() });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || "PDF 추출 중 오류가 발생했습니다." }, { status: 500 });
  } finally {
    if (workDir) {
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch {
        // noop
      }
    }
  }
}
