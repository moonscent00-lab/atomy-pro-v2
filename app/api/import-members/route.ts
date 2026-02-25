export const runtime = "nodejs";

import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { text } = await req.json();
  if (!text) return Response.json({ ok: false, error: "데이터가 없습니다." }, { status: 400 });

  const lines = text
    .split(/\r?\n/)
    .map((l: string) => l.trim())
    .filter(Boolean);

  // ✅ member_id 중복 제거용 (같은 id가 여러 번 나오면 마지막 값으로 덮어씀)
  const memberMap = new Map<number, any>();
  let parsedRows = 0;

  for (const line of lines) {
    if (line.startsWith("//")) continue;

    const parts = line.split("|").map((s: string) => s.trim());

    // [본인ID]|[스폰서ID]|[L/R]|[이름]|[센터]|[직급]|[매출일]|[누적PV]|[법인]
    if (parts.length >= 8) {
      const memberId = Number(parts[0]);
      const name = parts[3];
      const center = parts[4];
      const rank = parts[5];
      const date = parts[6] === "-" ? null : parts[6];
      const pv = Number((parts[7] || "").replace(/,/g, "")) || 0;
      const corporation = (parts[8] || "").trim() || null;

      if (!isNaN(memberId) && memberId > 10000) {
        parsedRows += 1;
        memberMap.set(memberId, {
          member_id: memberId,
          name,
          center,
          rank,
          corporation,
          last_purchase_date: date,
          cumulative_pv: pv,
        });
      }
    }
  }

  const membersToUpsert = Array.from(memberMap.values());

  if (membersToUpsert.length === 0) {
    return Response.json({ ok: false, error: "유효한 멤버 데이터를 찾을 수 없습니다." }, { status: 400 });
  }

  let error: { message: string } | null = null;
  {
    const resp = await supabase
      .from("members")
      .upsert(membersToUpsert, { onConflict: "member_id" });
    error = resp.error ? { message: resp.error.message } : null;
  }

  if (error && error.message.includes("corporation")) {
    const fallbackRows = membersToUpsert.map((m) => {
      const row = { ...m } as any;
      delete row.corporation;
      return row;
    });
    const resp2 = await supabase
      .from("members")
      .upsert(fallbackRows, { onConflict: "member_id" });
    error = resp2.error ? { message: resp2.error.message } : null;
  }

  if (error) {
    return Response.json({ ok: false, error: "Members 저장 에러: " + error.message }, { status: 500 });
  }

  // ✅ 참고용 통계도 같이 내려줌
  const duplicatesRemoved = parsedRows - membersToUpsert.length;

  return Response.json({
    ok: true,
    parsedRows,
    uniqueMembers: membersToUpsert.length,
    duplicatesRemoved,
  });
}
