export const runtime = "nodejs";

import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { parent_id, child_id, side } = await req.json();

  const p = Number(parent_id);
  const c = Number(child_id);
  const s = String(side || "").toUpperCase();

  if (!p || !c || !["L", "R"].includes(s)) {
    return Response.json({ ok: false, error: "parent_id, child_id, side(L/R) 필수" }, { status: 400 });
  }

  // ✅ child_id를 PK로 잡았으니 upsert로 안전하게 연결 변경 가능
  const { error } = await supabase
    .from("edges")
    .upsert([{ parent_id: p, child_id: c, side: s }], { onConflict: "child_id" });

  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  return Response.json({ ok: true });
}