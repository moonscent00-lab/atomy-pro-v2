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

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const files = form.getAll("files");

    if (!files || files.length === 0) {
      return Response.json({ ok: false, error: "PDF 파일이 없습니다." }, { status: 400 });
    }

    await ensurePdfJsPolyfills();
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Serverless에서 fake worker 경로 오류 방지: workerSrc를 data-url로 명시.
    if (pdfjs?.GlobalWorkerOptions) {
      const workerMod: any = await import("pdf-parse/worker");
      const workerSrc = workerMod?.getData?.() || workerMod?.getPath?.() || "";
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    }

    let mergedText = "";
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i] as File;
      const safeName = (f.name || `file-${i + 1}.pdf`).replace(/[^\w.\-가-힣]/g, "_");
      const bytes = new Uint8Array(await f.arrayBuffer());
      const loadingTask = pdfjs.getDocument({ data: bytes, disableWorker: true, useWorkerFetch: false });
      const doc = await loadingTask.promise;
      let text = "";
      for (let p = 1; p <= doc.numPages; p += 1) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const line = (content.items || [])
          .map((it: any) => String(it?.str || ""))
          .join(" ")
          .trim();
        if (line) text += `${line}\n`;
        page.cleanup();
      }
      await doc.destroy();

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
