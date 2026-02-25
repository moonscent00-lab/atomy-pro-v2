export const runtime = "nodejs";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

    const runner = join(process.cwd(), "scripts", "pdf_extract_runner.mjs");
    const { stdout, stderr } = await execFileAsync(process.execPath, [runner, ...paths], {
      maxBuffer: 30 * 1024 * 1024,
      cwd: process.cwd(),
    });

    if (stderr && stderr.trim()) {
      return Response.json({ ok: false, error: stderr.trim() }, { status: 500 });
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(stdout || "{}");
    } catch {
      return Response.json({ ok: false, error: "추출 결과 파싱 실패", raw: stdout?.slice(0, 2000) }, { status: 500 });
    }

    if (!parsed?.ok) {
      return Response.json({ ok: false, error: parsed?.error || "PDF 추출 실패" }, { status: 500 });
    }

    return Response.json({ ok: true, text: String(parsed.text || "") });
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

