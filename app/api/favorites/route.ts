export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authCookieName, verifySessionToken } from "@/lib/auth";

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function authOwner(req: NextRequest) {
  const token = req.cookies.get(authCookieName())?.value;
  const session = verifySessionToken(token);
  return session?.member_id ?? null;
}

export async function GET(req: NextRequest) {
  const ownerId = authOwner(req);
  if (!ownerId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const supabase = getSupabase();
  const res = await supabase
    .from("favorites")
    .select("id, owner_member_id, target_member_id, bucket, memo, sort_order, created_at, updated_at")
    .eq("owner_member_id", ownerId)
    .order("bucket", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (res.error) return NextResponse.json({ ok: false, error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, items: res.data || [] });
}

export async function POST(req: NextRequest) {
  const ownerId = authOwner(req);
  if (!ownerId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const target_member_id = Number(body?.target_member_id);
  const bucket = String(body?.bucket || "DAILY").toUpperCase() === "OCCASIONAL" ? "OCCASIONAL" : "DAILY";
  const memo = String(body?.memo || "");
  const sort_order = Number(body?.sort_order || 0);
  if (!Number.isFinite(target_member_id) || target_member_id <= 0) {
    return NextResponse.json({ ok: false, error: "target_member_id required" }, { status: 400 });
  }
  const supabase = getSupabase();
  const res = await supabase.from("favorites").upsert(
    [
      {
        owner_member_id: ownerId,
        target_member_id,
        bucket,
        memo,
        sort_order: Number.isFinite(sort_order) ? Math.trunc(sort_order) : 0,
      },
    ],
    { onConflict: "owner_member_id,target_member_id" }
  );
  if (res.error) return NextResponse.json({ ok: false, error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const ownerId = authOwner(req);
  if (!ownerId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const id = Number(body?.id);
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const payload: Record<string, string | number> = {};
  if (body?.bucket != null) payload.bucket = String(body.bucket).toUpperCase() === "OCCASIONAL" ? "OCCASIONAL" : "DAILY";
  if (body?.memo != null) payload.memo = String(body.memo);
  if (body?.sort_order != null) payload.sort_order = Math.trunc(Number(body.sort_order) || 0);
  if (Object.keys(payload).length === 0) return NextResponse.json({ ok: false, error: "변경값이 없습니다." }, { status: 400 });

  const supabase = getSupabase();
  const res = await supabase.from("favorites").update(payload).eq("id", id).eq("owner_member_id", ownerId);
  if (res.error) return NextResponse.json({ ok: false, error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const ownerId = authOwner(req);
  if (!ownerId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body?.id || 0);
  const target_member_id = Number(body?.target_member_id || 0);
  const supabase = getSupabase();
  if (id > 0) {
    const res = await supabase.from("favorites").delete().eq("id", id).eq("owner_member_id", ownerId);
    if (res.error) return NextResponse.json({ ok: false, error: res.error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  if (target_member_id > 0) {
    const res = await supabase
      .from("favorites")
      .delete()
      .eq("owner_member_id", ownerId)
      .eq("target_member_id", target_member_id);
    if (res.error) return NextResponse.json({ ok: false, error: res.error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, error: "id 또는 target_member_id 필요" }, { status: 400 });
}

