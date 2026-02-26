export const runtime = "nodejs";

async function ensurePdfJsPolyfills() {
  const g = globalThis as any;
  if (!g.DOMMatrix) {
    const dm: any = await import("dommatrix");
    const DOMMatrixCtor = dm?.default ?? dm;
    g.DOMMatrix = DOMMatrixCtor;
    if (!g.DOMMatrixReadOnly) g.DOMMatrixReadOnly = DOMMatrixCtor;
  }
}

async function getWorkerDataUrl() {
  const g = globalThis as any;
  if (typeof g.__pdfWorkerDataUrl === "string" && g.__pdfWorkerDataUrl.startsWith("data:text/javascript")) {
    return g.__pdfWorkerDataUrl as string;
  }
  const url = "https://cdn.jsdelivr.net/npm/pdf-parse@2.4.5/dist/pdf-parse/web/pdf.worker.min.mjs";
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`worker fetch 실패 (${res.status})`);
  const text = await res.text();
  const dataUrl = `data:text/javascript;base64,${Buffer.from(text, "utf8").toString("base64")}`;
  g.__pdfWorkerDataUrl = dataUrl;
  return dataUrl;
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const files = form.getAll("files");

    if (!files || files.length === 0) {
      return Response.json({ ok: false, error: "PDF 파일이 없습니다." }, { status: 400 });
    }

    await ensurePdfJsPolyfills();
    const pdfMod: any = await import("pdf-parse");
    const PDFParse = pdfMod?.PDFParse ?? pdfMod?.default?.PDFParse ?? pdfMod?.default;
    if (!PDFParse) {
      return Response.json({ ok: false, error: "pdf-parse 로딩 실패" }, { status: 500 });
    }
    if (typeof PDFParse?.setWorker === "function") {
      const workerSrc = await getWorkerDataUrl();
      PDFParse.setWorker(workerSrc);
    }

    let mergedText = "";
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i] as File;
      const safeName = (f.name || `file-${i + 1}.pdf`).replace(/[^\w.\-가-힣]/g, "_");
      const data = new Uint8Array(await f.arrayBuffer());
      const parser = new PDFParse({ data, useWorkerFetch: true });
      const result = await parser.getText();
      await parser.destroy();

      let text = String(result?.text || "");

      text = String(text || "")
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      mergedText += `\n\n// --- ${safeName} ---\n`;
      if (text) mergedText += `${text}\n`;
    }

    return Response.json({ ok: true, text: mergedText.trim() });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || "PDF 추출 중 오류가 발생했습니다." }, { status: 500 });
  }
}
