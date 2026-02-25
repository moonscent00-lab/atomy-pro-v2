export const runtime = "nodejs";

import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { q } = await req.json();
  const query = String(q || "").trim();

  if (!query) return Response.json({ ok: true, items: [] });

  const isNumeric = /^[0-9]+$/.test(query);

  let resp;
  if (isNumeric) {
    resp = await supabase
      .from("members")
      .select("member_id,name")
      .eq("member_id", Number(query))
      .limit(20);
  } else {
    resp = await supabase
      .from("members")
      .select("member_id,name")
      .ilike("name", `%${query}%`)
      .order("member_id", { ascending: true })
      .limit(20);
  }

  if (resp.error) {
    return Response.json({ ok: false, error: resp.error.message }, { status: 500 });
  }

  return Response.json({ ok: true, items: resp.data ?? [] });
}