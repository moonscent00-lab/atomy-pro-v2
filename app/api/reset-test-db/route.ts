export const runtime = "nodejs";

import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const body = await req.json().catch(() => ({}));
    const confirm = String(body?.confirm || "").trim().toUpperCase();
    if (confirm !== "RESET") {
      return Response.json(
        { ok: false, error: "초기화 확인값이 필요합니다. confirm=RESET 로 호출해 주세요." },
        { status: 400 }
      );
    }

    const edgesResp = await supabase.from("edges").delete().gt("child_id", 0).select("child_id");
    if (edgesResp.error) {
      return Response.json({ ok: false, error: "edges 초기화 실패: " + edgesResp.error.message }, { status: 500 });
    }

    const membersResp = await supabase.from("members").delete().gt("member_id", 0).select("member_id");
    if (membersResp.error) {
      return Response.json({ ok: false, error: "members 초기화 실패: " + membersResp.error.message }, { status: 500 });
    }

    return Response.json({
      ok: true,
      deleted: {
        edges: edgesResp.data?.length ?? 0,
        members: membersResp.data?.length ?? 0,
      },
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "DB 초기화 실패" }, { status: 500 });
  }
}

