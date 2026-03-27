// app/page.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Member = { member_id: number; name: string };
type MemberDetailLite = { member_id: number; name: string; center: string; rank: string; corporation: string };

type TreeNode = {
  id: number;
  name: string;
  rank?: string | null;
  driving_side?: "L" | "R" | null;
  cumulative_pv?: number | null;
  left_line_pv?: number | null;
  right_line_pv?: number | null;
  tier_grade?: number | null;
  tier_points?: number | null;
  tier_title?: string | null;
  last_purchase_date?: string | null;
  is_leaving?: boolean;
  side?: "L" | "R";
  children?: TreeNode[]; // expected order: [L, R] (if provided)
};

type ParsedPdfMember = {
  member_id: number;
  name: string;
  rank: string;
  nominal_rank?: string;
  current_rank?: string;
  cumulative_pv: number;
  center: string;
  corporation: string;
  last_purchase_date: string | null;
  confidence?: number;
  raw?: string;
};

type ApiOk<T> = { ok: true } & T;
type ApiErr = { ok: false; error: string };
type AuthUser = { member_id: number };

type DashboardFav = {
  id: number;
  bucket: "DAILY" | "OCCASIONAL";
  memo: string;
  member_id: number;
  name: string;
  cumulative_pv: number;
  left_line_pv: number;
  right_line_pv: number;
  last_allowance_date: string | null;
  target_threshold: number;
  부족: { left: number; right: number; own: number };
};

type DashboardData = {
  owner: {
    member_id: number;
    name: string;
    cumulative_pv: number;
    left_line_pv: number;
    right_line_pv: number;
    last_purchase_date: string | null;
    last_allowance_date: string | null;
    half_month: {
      first_half_pv: number;
      second_half_pv: number;
    };
  };
  favorites: {
    daily: DashboardFav[];
    occasional: DashboardFav[];
  };
};

type Mode = "dashboard" | "link" | "members" | "tree" | "parser" | "settle";

function clampDepth(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.trunc(value), 1), 30);
}

function resolveRankTier(rank?: string | null, isLeaving?: boolean) {
  if (isLeaving) return "leaving";
  const txt = String(rank || "").trim();
  if (!txt) return "unknown";
  if (txt.includes("자가소비")) return "self";
  if (
    txt.includes("에이전트") ||
    txt.includes("대리점") ||
    txt.includes("특약점") ||
    txt.includes("세일즈마스터") ||
    txt.includes("다이아몬드마스터")
  ) {
    return "agent_plus";
  }
  if (txt.includes("회원") || txt.includes("판매원")) return "member";
  return "unknown";
}

function safeJsonStringify(v: any) {
  try {
    return JSON.stringify(v ?? null, null, 2);
  } catch {
    return String(v);
  }
}

function formatPv(value?: number | null) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("ko-KR");
}

function shortRankLabel(rank?: string | null) {
  const txt = String(rank || "").trim();
  if (!txt) return "";
  return txt
    .replaceAll("세일즈마스터", "SM")
    .replaceAll("다이아몬드마스터", "DM")
    .replaceAll("샤론로즈마스터", "SRM")
    .replaceAll("스타마스터", "STM")
    .replaceAll("로얄마스터", "RM")
    .replaceAll("크라운마스터", "CM")
    .replaceAll("임페리얼마스터", "IM");
}

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function findNextTarget(leftPv: number, rightPv: number) {
  const targets = [300_000, 700_000, 1_500_000, 2_400_000, 6_000_000, 20_000_000, 50_000_000];
  for (const t of targets) {
    if (leftPv < t || rightPv < t) return t;
  }
  return targets[targets.length - 1];
}

function useDebounced<T>(value: T, delayMs = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function normalizeChildren(node: TreeNode | null): TreeNode | null {
  if (!node) return node;
  const kids = Array.isArray(node.children) ? [...node.children] : [];
  // If API includes side per child, sort to [L,R]
  kids.sort((a, b) => (a.side === "L" ? -1 : 1) - (b.side === "L" ? -1 : 1));
  const left = kids.find((c) => c.side === "L") ?? kids[0] ?? null;
  const right = kids.find((c) => c.side === "R") ?? kids[1] ?? null;
  const outKids: TreeNode[] = [];
  if (left) outKids.push(normalizeChildren(left)!);
  if (right) outKids.push(normalizeChildren(right)!);
  return { ...node, children: outKids };
}

function pickChildBySide(node: TreeNode | null, side: "L" | "R"): TreeNode | null {
  if (!node?.children?.length) return null;
  const byTag = node.children.find((c) => c?.side === side);
  if (byTag) return byTag;
  return side === "L" ? node.children[0] ?? null : node.children[1] ?? null;
}

function collapseLeavingForSide(node: TreeNode | null, side: "L" | "R"): TreeNode | null {
  let cur = node;
  let guard = 0;
  while (cur?.id && cur.is_leaving && guard < 200) {
    const sameSide = pickChildBySide(cur, side);
    const otherSide = pickChildBySide(cur, side === "L" ? "R" : "L");
    cur = sameSide || otherSide || null;
    guard += 1;
  }
  if (!cur?.id) return null;
  return { ...cur, side };
}

function collapseLeavingTree(node: TreeNode | null): TreeNode | null {
  if (!node?.id) return node;
  const leftRaw = pickChildBySide(node, "L");
  const rightRaw = pickChildBySide(node, "R");
  const left = collapseLeavingForSide(leftRaw, "L");
  const right = collapseLeavingForSide(rightRaw, "R");

  const outChildren: TreeNode[] = [];
  if (left) {
    const x = collapseLeavingTree(left);
    if (x) outChildren.push({ ...x, side: "L" });
  }
  if (right) {
    const x = collapseLeavingTree(right);
    if (x) outChildren.push({ ...x, side: "R" });
  }
  return { ...node, children: outChildren };
}

function buildLevels(root: TreeNode, depth: number) {
  // Builds a complete binary level array up to `depth`.
  // levels[d] length = 2^d (placeholders included)
  type Slot = { node: TreeNode | null; side?: "L" | "R" };
  const levels: Slot[][] = [];

  levels.push([{ node: root }]);
  for (let d = 0; d < depth; d++) {
    const cur = levels[d];
    const next: Slot[] = [];
    for (const slot of cur) {
      const n = slot.node;
      const kids = n?.children ?? [];
      const left = kids[0] ?? null;
      const right = kids[1] ?? null;
      next.push({ node: left, side: "L" });
      next.push({ node: right, side: "R" });
    }
    levels.push(next);
  }
  return levels;
}

function TreeBinaryView({
  root,
  depth,
  theme,
  isMobile = false,
  showPlaceholders = false,
  onNodeClick,
}: {
  root: TreeNode | null;
  depth: number;
  theme: any;
  isMobile?: boolean;
  showPlaceholders?: boolean;
  onNodeClick?: (node: TreeNode) => void;
}) {
  if (!root) return null;

  // ---- layout constants ----
  const CARD_W = 200;
  const CARD_H = 74;
  const GAP_X = 28;
  const GAP_Y = 70;
  const PAD_X = 60;
  const PAD_Y = 40;

  type PositionedNode = {
    key: string;
    id: number;
    name: string;
    rank?: string | null;
    driving_side?: "L" | "R" | null;
    cumulative_pv?: number | null;
    left_line_pv?: number | null;
    right_line_pv?: number | null;
    tier_grade?: number | null;
    tier_points?: number | null;
    tier_title?: string | null;
    last_purchase_date?: string | null;
    is_leaving?: boolean;
    side?: "L" | "R";
    level: number;
    xIndex: number;
    children: string[];
    placeholder?: boolean;
  };

  const maxDepth = Math.max(0, depth);
  const byKey = new Map<string, PositionedNode>();
  let leafCursor = 0;

  const walk = (node: any, level: number, key: string, side?: "L" | "R"): number => {
    const children: Array<{ node: any; side: "L" | "R"; key: string }> = [];
    const rawKids = Array.isArray(node?.children) ? node.children : [];
    const left = rawKids[0];
    const right = rawKids[1];

    if (level < maxDepth) {
      if (left?.id) {
        children.push({ node: left, side: "L", key: `${key}-L` });
      } else if (showPlaceholders) {
        children.push({
          node: { id: 0, name: "(비어있음)", rank: null, driving_side: "L", cumulative_pv: 0, last_purchase_date: null, is_leaving: false, side: "L", placeholder: true, children: [] },
          side: "L",
          key: `${key}-L`,
        });
      }

      if (right?.id) {
        children.push({ node: right, side: "R", key: `${key}-R` });
      } else if (showPlaceholders) {
        children.push({
          node: { id: 0, name: "(비어있음)", rank: null, driving_side: "L", cumulative_pv: 0, last_purchase_date: null, is_leaving: false, side: "R", placeholder: true, children: [] },
          side: "R",
          key: `${key}-R`,
        });
      }
    }

    const childXs = children.map((child) => walk(child.node, level + 1, child.key, child.side));

    let xIndex = leafCursor;
    if (childXs.length === 0) {
      leafCursor += 1;
    } else if (childXs.length === 1) {
      xIndex = childXs[0];
    } else {
      xIndex = (childXs[0] + childXs[childXs.length - 1]) / 2;
    }

    byKey.set(key, {
      key,
      id: Number(node?.id ?? 0),
      name: String(node?.name ?? "(이름없음)"),
      rank: node?.rank ?? null,
      driving_side: node?.driving_side === "R" ? "R" : "L",
      cumulative_pv: Number(node?.cumulative_pv ?? 0),
      left_line_pv: Number(node?.left_line_pv ?? 0),
      right_line_pv: Number(node?.right_line_pv ?? 0),
      tier_grade: node?.tier_grade == null ? null : Number(node?.tier_grade),
      tier_points: node?.tier_points == null ? null : Number(node?.tier_points),
      tier_title: node?.tier_title ?? null,
      last_purchase_date: node?.last_purchase_date ?? null,
      is_leaving: Boolean(node?.is_leaving),
      side,
      level,
      xIndex,
      children: children.map((c) => c.key),
      placeholder: Boolean(node?.placeholder) || !node?.id,
    });

    return xIndex;
  };

  walk(root, 0, "root");

  const nodes = Array.from(byKey.values());
  const maxLevel = nodes.reduce((mx, n) => Math.max(mx, n.level), 0);
  const cols = Math.max(1, leafCursor);
  const canvasW = PAD_X * 2 + cols * CARD_W + Math.max(0, cols - 1) * GAP_X;
  const canvasH = PAD_Y * 2 + (maxLevel + 1) * CARD_H + maxLevel * GAP_Y;

  const nodeCenterX = (xIndex: number) => PAD_X + xIndex * (CARD_W + GAP_X) + CARD_W / 2;
  const nodeTopY = (level: number) => PAD_Y + level * (CARD_H + GAP_Y);
  const nodesByLevel = nodes.reduce<Record<number, PositionedNode[]>>((acc, n) => {
    if (!acc[n.level]) acc[n.level] = [];
    acc[n.level].push(n);
    return acc;
  }, {});

  // ---- Pan / Zoom (drag to pan, wheel to zoom) ----
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = React.useState(1);
  const [pos, setPos] = React.useState({ x: 0, y: 0 });
  const dragRef = React.useRef<{ down: boolean; sx: number; sy: number; ox: number; oy: number }>({
    down: false,
    sx: 0,
    sy: 0,
    ox: 0,
    oy: 0,
  });
  const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = React.useRef<{ startDist: number; startScale: number } | null>(null);
  const touchRef = React.useRef<
    | {
        mode: "pan";
        startX: number;
        startY: number;
        originX: number;
        originY: number;
      }
    | {
        mode: "pinch";
        startDist: number;
        startScale: number;
      }
    | null
  >(null);

  // fit-to-view initial scale
  React.useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const vw = el.clientWidth || 1200;
    const vh = el.clientHeight || 600;

    const fit = Math.min((vw - 40) / canvasW, (vh - 40) / canvasH, 1);
    setScale(fit);

    // center canvas
    const cx = (vw - canvasW * fit) / 2;
    const cy = 20;
    setPos({ x: cx, y: cy });
  }, [canvasW, canvasH]);

  React.useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const prevent = (ev: Event) => ev.preventDefault();
    el.addEventListener("gesturestart", prevent, { passive: false } as AddEventListenerOptions);
    el.addEventListener("gesturechange", prevent, { passive: false } as AddEventListenerOptions);
    el.addEventListener("gestureend", prevent, { passive: false } as AddEventListenerOptions);
    return () => {
      el.removeEventListener("gesturestart", prevent as EventListener);
      el.removeEventListener("gesturechange", prevent as EventListener);
      el.removeEventListener("gestureend", prevent as EventListener);
    };
  }, []);

  const applyZoomAt = (mx: number, my: number, nextScale: number) => {
    const safeScale = Math.max(0.12, Math.min(2.5, nextScale));
    const wx = (mx - pos.x) / scale;
    const wy = (my - pos.y) / scale;
    const nx = mx - wx * safeScale;
    const ny = my - wy * safeScale;
    setScale(safeScale);
    setPos({ x: nx, y: ny });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const delta = e.deltaY;
    applyZoomAt(mx, my, scale * (delta > 0 ? 0.92 : 1.08));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("[data-tree-card='1']")) return;
    const el = viewportRef.current;
    if (!el) return;
    (e.currentTarget as any).setPointerCapture?.(e.pointerId);

    dragRef.current.down = true;
    dragRef.current.sx = e.clientX;
    dragRef.current.sy = e.clientY;
    dragRef.current.ox = pos.x;
    dragRef.current.oy = pos.y;

    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      pinchRef.current = { startDist: dist, startScale: scale };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pointersRef.current.size === 2 && pinchRef.current) {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const ratio = dist / Math.max(1, pinchRef.current.startDist);
      const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
      applyZoomAt(cx, cy, pinchRef.current.startScale * ratio);
      return;
    }
    if (!dragRef.current.down) return;
    const dx = e.clientX - dragRef.current.sx;
    const dy = e.clientY - dragRef.current.sy;
    setPos({ x: dragRef.current.ox + dx, y: dragRef.current.oy + dy });
  };

  const onPointerUp = (e?: React.PointerEvent) => {
    if (e) pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    dragRef.current.down = false;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("[data-tree-card='1']")) return;
    if (e.touches.length === 1) {
      const t0 = e.touches[0];
      touchRef.current = {
        mode: "pan",
        startX: t0.clientX,
        startY: t0.clientY,
        originX: pos.x,
        originY: pos.y,
      };
    } else if (e.touches.length === 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      touchRef.current = {
        mode: "pinch",
        startDist: dist,
        startScale: scale,
      };
    } else {
      touchRef.current = null;
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const el = viewportRef.current;
    if (!el) return;
    if (e.cancelable) e.preventDefault();

    const st = touchRef.current;
    if (!st) return;

    if (st.mode === "pan" && e.touches.length === 1) {
      const t0 = e.touches[0];
      const dx = t0.clientX - st.startX;
      const dy = t0.clientY - st.startY;
      setPos({ x: st.originX + dx, y: st.originY + dy });
      return;
    }

    if (e.touches.length === 2) {
      const rect = el.getBoundingClientRect();
      const a = e.touches[0];
      const b = e.touches[1];
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      const ratio = dist / Math.max(1, st.mode === "pinch" ? st.startDist : dist);
      const cx = (a.clientX + b.clientX) / 2 - rect.left;
      const cy = (a.clientY + b.clientY) / 2 - rect.top;
      const baseScale = st.mode === "pinch" ? st.startScale : scale;
      applyZoomAt(cx, cy, baseScale * ratio);
    }
  };

  const onTouchEnd = () => {
    touchRef.current = null;
  };

  const resetView = () => {
    const el = viewportRef.current;
    if (!el) return;
    const vw = el.clientWidth || 1200;
    const vh = el.clientHeight || 600;

    const fit = Math.min((vw - 40) / canvasW, (vh - 40) / canvasH, 1);
    setScale(fit);
    setPos({ x: (vw - canvasW * fit) / 2, y: 20 });
  };

  const getBorderColor = (rank?: string | null, isLeaving?: boolean) => {
    const tier = resolveRankTier(rank, isLeaving);
    if (tier === "self") return "#7C3AED";
    if (tier === "member") return "#16A34A";
    if (tier === "agent_plus") return "#2563EB";
    if (tier === "leaving") return "#DC2626";
    return theme.border;
  };

  const cardStyle = (isPh: boolean, rank?: string | null, isLeaving?: boolean) => ({
    width: CARD_W,
    minHeight: CARD_H,
    padding: "10px 12px",
    borderRadius: 14,
    border: `2px solid ${getBorderColor(rank, isLeaving)}`,
    background: isPh ? "transparent" : theme.surface,
    opacity: isPh ? 0.22 : 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    boxShadow: isPh ? "none" : theme.shadow,
    pointerEvents: (isPh ? "none" : "auto") as React.CSSProperties["pointerEvents"],
    userSelect: "none" as const,
  });

  return (
    <div>
      {/* mini controls */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <button
          type="button"
          onClick={resetView}
          style={{
            padding: "8px 10px",
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            background: theme.surface,
            cursor: "pointer",
          }}
        >
          화면 맞춤
        </button>
        <div style={{ fontSize: 12, color: theme.muted }}>
          드래그: 이동 · 줌: 휠/핀치 ({Math.round(scale * 100)}%)
        </div>
      </div>

      {/* viewport (pan/zoom area) */}
      <div
        ref={viewportRef}
        onWheelCapture={onWheel}
        onWheel={onWheel}
        onPointerDown={isMobile ? undefined : onPointerDown}
        onPointerMove={isMobile ? undefined : onPointerMove}
        onPointerUp={isMobile ? undefined : (e) => onPointerUp(e)}
        onPointerCancel={isMobile ? undefined : (e) => onPointerUp(e)}
        onPointerLeave={isMobile ? undefined : () => onPointerUp()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{
          width: "100%",
          height: isMobile ? "62vh" : "72vh",
          border: `1px solid ${theme.border}`,
          borderRadius: 18,
          background: theme.bg,
          overflow: "hidden",
          position: "relative",
          touchAction: "none",
          overscrollBehavior: "contain",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
            transformOrigin: "0 0",
            width: canvasW,
            height: canvasH,
          }}
        >
          {/* lines */}
          <svg width={canvasW} height={canvasH} style={{ position: "absolute", left: 0, top: 0 }}>
            {nodes.flatMap((parent) => {
              if ((!showPlaceholders && parent.placeholder) || parent.children.length === 0) return [];

              const px = nodeCenterX(parent.xIndex);
              const py = nodeTopY(parent.level) + CARD_H;

              return parent.children.flatMap((childKey) => {
                const child = byKey.get(childKey);
                if (!child) return [];
                if (!showPlaceholders && child.placeholder) return [];

                const cx = nodeCenterX(child.xIndex);
                const cy = nodeTopY(child.level);
                const midY = py + GAP_Y / 2;

                return (
                  <path
                    key={`e-${parent.key}-${child.key}`}
                    d={`M ${px} ${py} L ${px} ${midY} L ${cx} ${midY} L ${cx} ${cy}`}
                    fill="none"
                    stroke={theme.border}
                    strokeWidth={1}
                  />
                );
              });
            })}
          </svg>

          {/* nodes */}
          {Object.entries(nodesByLevel).map(([levelKey, row]) => {
            const level = Number(levelKey);
            return (
              <div key={level} style={{ position: "absolute", left: 0, top: nodeTopY(level), width: canvasW, height: CARD_H }}>
                {row.map((n) => {
                  const isPh = n?.placeholder || !n?.id;
                if (!showPlaceholders && isPh) return null;

                  const x = nodeCenterX(n.xIndex) - CARD_W / 2;
                return (
                    <div key={n.key} style={{ position: "absolute", left: x, top: 0 }}>
                    <div
                      data-tree-card="1"
                      style={{
                        ...cardStyle(isPh, n.rank, n.is_leaving),
                        cursor: !isPh && n.id ? "pointer" : "default",
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isPh && n.id && onNodeClick) {
                          onNodeClick({
                            id: n.id,
                            name: n.name,
                            rank: n.rank,
                            driving_side: n.driving_side,
                            cumulative_pv: n.cumulative_pv,
                            left_line_pv: n.left_line_pv,
                            right_line_pv: n.right_line_pv,
                            tier_grade: n.tier_grade,
                            tier_points: n.tier_points,
                            tier_title: n.tier_title,
                            last_purchase_date: n.last_purchase_date,
                            is_leaving: n.is_leaving,
                            side: n.side,
                            children: [],
                          });
                        }
                      }}
                    >
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 10,
                            border: `1px solid ${theme.border}`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 800,
                            fontSize: 12,
                            background: theme.surface2,
                          }}
                        >
                            {n.side ?? (level === 0 ? "ROOT" : "")}
                        </div>
                        <div>
                            <div style={{ fontWeight: 800, fontSize: 14, color: theme.text }}>{n.name || "(이름없음)"}</div>
                            <div style={{ fontSize: 12, color: theme.muted }}>
                              {n.id || 0}
                              {n.rank ? ` · ${shortRankLabel(n.rank)}` : ""}
                            </div>
                            <div style={{ fontSize: 11, color: theme.muted }}>PV {formatPv(n.cumulative_pv)}</div>
                            <div style={{ fontSize: 11, color: theme.muted }}>
                              좌PV {formatPv(n.left_line_pv)} / 우PV {formatPv(n.right_line_pv)}
                            </div>
                            {n.tier_grade ? (
                              <div style={{ fontSize: 11, color: theme.muted }}>
                                티어 {n.tier_grade}급 · {n.tier_points ?? 0}점 {n.tier_title ? `(${n.tier_title})` : ""}
                              </div>
                            ) : null}
                            <div style={{ fontSize: 11, color: theme.muted }}>마지막 매출일 {n.last_purchase_date || "-"}</div>
                            </div>
                        </div>
                      </div>
                  </div>
                );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function Home(
) {
  const isDev = process.env.NODE_ENV !== "production";
  // ===== Theme (Notion-like: light default + optional dark) =====
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const t = useMemo(() => {
    const light = {
      bg: "#F5F5F4",
      surface: "#FFFFFF",
      surface2: "#FAFAFA",
      border: "#E7E5E4",
      text: "#111111",
      muted: "#6B7280",
      ok: "#16A34A",
      danger: "#DC2626",
      shadow: "0 6px 24px rgba(0,0,0,0.06)",
    };
    const dark = {
      bg: "#0B0C0F",
      surface: "#111318",
      surface2: "#151922",
      border: "#2A2F3A",
      text: "#E5E7EB",
      muted: "#9CA3AF",
      ok: "#22C55E",
      danger: "#F87171",
      shadow: "0 10px 34px rgba(0,0,0,0.35)",
    };
    return theme === "light" ? light : dark;
  }, [theme]);

  // ===== Mode =====
  const [mode, setMode] = useState<Mode>("dashboard");
  const [isMobile, setIsMobile] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [setupMode, setSetupMode] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [loginForm, setLoginForm] = useState({ member_id: "", password: "" });
  const [loginLoading, setLoginLoading] = useState(false);
  const [signupMode, setSignupMode] = useState(false);
  const [signupLoading, setSignupLoading] = useState(false);
  const [signupForm, setSignupForm] = useState({
    member_id: "",
    name: "",
    center: "",
    sponsor_id: "",
  });
  const [resetForm, setResetForm] = useState({ member_id: "", newPassword: "", adminCode: "" });
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [favForm, setFavForm] = useState({ target_member_id: "", memo: "", bucket: "DAILY" as "DAILY" | "OCCASIONAL" });

  useEffect(() => {
    const url = new URL(window.location.href);
    const authError = url.searchParams.get("auth_error");
    const authOk = url.searchParams.get("auth_ok");
    if (!authError && !authOk) return;
    if (authError) setToast({ type: "err", msg: authError });
    if (authOk) setToast({ type: "ok", msg: authOk });
    url.searchParams.delete("auth_error");
    url.searchParams.delete("auth_ok");
    window.history.replaceState({}, "", url.toString());
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [mode]);

  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth < 900);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (res.ok && json?.ok) setAuthUser(json.user);
        else setAuthUser(null);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  // ===== Toast =====
  const [toast, setToast] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  // ===== (A) Link =====
  const [sponsorQ, setSponsorQ] = useState("");
  const [partnerQ, setPartnerQ] = useState("");
  const sponsorQd = useDebounced(sponsorQ, 250);
  const partnerQd = useDebounced(partnerQ, 250);

  const [sponsorItems, setSponsorItems] = useState<Member[]>([]);
  const [partnerItems, setPartnerItems] = useState<Member[]>([]);

  const [sponsorSel, setSponsorSel] = useState<Member | null>(null);
  const [partnerSel, setPartnerSel] = useState<Member | null>(null);
  const [lineDriveMode, setLineDriveMode] = useState(true);
  const partnerInputRef = useRef<HTMLInputElement | null>(null);

  const [side, setSide] = useState<"L" | "R">("L");
  const [linkResult, setLinkResult] = useState<any>(null);
  const [debug, setDebug] = useState<any>(null);

  async function fetchMembers(q: string) {
    const res = await fetch("/api/members-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q }),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { ok: false, error: "Invalid JSON", raw: text };
    }
    return { res, json };
  }

  async function search(where: "sponsor" | "partner", q: string) {
    const { res, json } = await fetchMembers(q);

    setDebug({ where, q, status: res.status, json });

    if (!res.ok || !json?.ok) {
      if (where === "sponsor") setSponsorItems([]);
      else setPartnerItems([]);
      return;
    }

    const items: Member[] = json.items ?? json.results ?? [];
    if (where === "sponsor") {
      setSponsorItems(items);
      if (items.length === 1) setSponsorSel(items[0]);
    } else {
      setPartnerItems(items);
      if (items.length === 1) setPartnerSel(items[0]);
    }
  }

  useEffect(() => {
    const q = sponsorQd.trim();
    if (!q) {
      setSponsorItems([]);
      return;
    }
    search("sponsor", q).catch((e) => setDebug({ where: "sponsor", q, error: e?.message ?? String(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sponsorQd]);

  useEffect(() => {
    const q = partnerQd.trim();
    if (!q) {
      setPartnerItems([]);
      return;
    }
    search("partner", q).catch((e) => setDebug({ where: "partner", q, error: e?.message ?? String(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerQd]);

  async function saveLink(options?: { lineDrive?: boolean }) {
    const currentSponsor = sponsorSel;
    const currentPartner = partnerSel;
    const useLineDrive = options?.lineDrive ?? lineDriveMode;

    if (!currentSponsor?.member_id || !currentPartner?.member_id || !side) {
      setToast({ type: "err", msg: "스폰서/파트너/좌우(side) 선택이 필요합니다." });
      return;
    }
    setToast(null);
    setLinkResult(null);

    const res = await fetch("/api/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id: currentSponsor.member_id, child_id: currentPartner.member_id, side }),
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { ok: false, error: "Invalid JSON", raw: text };
    }

    setLinkResult(json);
    if (res.ok && json?.ok) {
      if (useLineDrive) {
        // 라인타기: 방금 등록한 파트너를 다음 스폰서로 자동 승격
        setSponsorSel(currentPartner);
        setSponsorQ(`${currentPartner.name} ${currentPartner.member_id}`);
        setSponsorItems([currentPartner]);
        setPartnerSel(null);
        setPartnerQ("");
        setPartnerItems([]);
        requestAnimationFrame(() => {
          partnerInputRef.current?.focus();
        });
        setToast({ type: "ok", msg: "연결 저장 완료 ✅ 라인타기 적용됨" });
      } else {
        setToast({ type: "ok", msg: "연결 저장 완료 ✅" });
      }
    } else {
      setToast({ type: "err", msg: json?.error ?? `연결 저장 실패 (HTTP ${res.status})` });
      if (useLineDrive) {
        requestAnimationFrame(() => {
          partnerInputRef.current?.focus();
        });
      }
    }
  }

  // ===== (B) Bulk members =====
  const [membersText, setMembersText] = useState("");
  const [quickCreate, setQuickCreate] = useState({
    member_id: "",
    name: "",
    center: "",
    sponsor_id: "",
  });
  const [quickCreateLoading, setQuickCreateLoading] = useState(false);
  const [quickEditQ, setQuickEditQ] = useState("");
  const quickEditQd = useDebounced(quickEditQ, 250);
  const [quickEditItems, setQuickEditItems] = useState<Member[]>([]);
  const [quickEditLoading, setQuickEditLoading] = useState(false);
  const [quickEditForm, setQuickEditForm] = useState<MemberDetailLite | null>(null);
  const [importResult, setImportResult] = useState<any>(null);
  const [resetDbLoading, setResetDbLoading] = useState(false);
  const [salesText, setSalesText] = useState("");
  const [salesLoading, setSalesLoading] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [salesResult, setSalesResult] = useState<any>(null);
  const [treeNeedsReload, setTreeNeedsReload] = useState(false);
  const [pdfRaw, setPdfRaw] = useState("");
  const [pdfParseLoading, setPdfParseLoading] = useState(false);
  const [pdfItems, setPdfItems] = useState<ParsedPdfMember[]>([]);
  const [pdfParseStats, setPdfParseStats] = useState<any>(null);
  const pdfFileInputRef = useRef<HTMLInputElement | null>(null);

  async function importMembers() {
    setToast(null);
    setImportResult(null);
    const res = await fetch("/api/import-members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: membersText }),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { ok: false, error: "Invalid JSON", raw: text };
    }
    setImportResult(json);
    if (res.ok && json?.ok) setToast({ type: "ok", msg: "멤버 저장 완료 ✅" });
    else setToast({ type: "err", msg: json?.error ?? `멤버 저장 실패 (HTTP ${res.status})` });
  }

  useEffect(() => {
    const q = quickEditQd.trim();
    if (!q) {
      setQuickEditItems([]);
      return;
    }
    fetchMembers(q)
      .then(({ res, json }) => {
        if (!res.ok || !json?.ok) {
          setQuickEditItems([]);
          return;
        }
        const items: Member[] = json.items ?? json.results ?? [];
        setQuickEditItems(items);
      })
      .catch(() => setQuickEditItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickEditQd]);

  async function quickCreateMember() {
    const memberId = quickCreate.member_id.replace(/\D/g, "").slice(0, 8);
    const sponsorId = quickCreate.sponsor_id.replace(/\D/g, "").slice(0, 8);
    const name = quickCreate.name.trim();
    const center = quickCreate.center.trim();
    if (!/^\d{8}$/.test(memberId)) {
      setToast({ type: "err", msg: "회원번호는 8자리 숫자여야 합니다." });
      return;
    }
    if (!name) {
      setToast({ type: "err", msg: "이름을 입력해 주세요." });
      return;
    }
    if (sponsorId && !/^\d{8}$/.test(sponsorId)) {
      setToast({ type: "err", msg: "스폰서 번호는 8자리 숫자여야 합니다." });
      return;
    }
    setQuickCreateLoading(true);
    setToast(null);
    try {
      const res = await fetch("/api/members-quick-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          member_id: Number(memberId),
          name,
          center: center || "센터",
          sponsor_id: sponsorId ? Number(sponsorId) : null,
        }),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok || !json?.ok) {
        setToast({ type: "err", msg: "간편 등록 실패: " + (json?.error ?? `HTTP ${res.status}`) });
        return;
      }
      const side = json?.side ? ` (${json.side})` : "";
      const msg = json?.linked ? `신규 회원 등록 완료 ✅ 스폰서 자동 연결${side}` : "신규 회원 등록 완료 ✅";
      setToast({ type: json?.warning ? "err" : "ok", msg: json?.warning ? `${msg} · ${json.warning}` : msg });
      setQuickCreate((prev) => ({ ...prev, member_id: "", name: "" }));
      await loadDashboard();
      setTreeNeedsReload(true);
    } catch (e: any) {
      setToast({ type: "err", msg: "간편 등록 오류: " + (e?.message ?? String(e)) });
    } finally {
      setQuickCreateLoading(false);
    }
  }

  async function selectQuickEditMember(item: Member) {
    setQuickEditLoading(true);
    setToast(null);
    try {
      const res = await fetch(`/api/member-detail?member_id=${item.member_id}`, { cache: "no-store" });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok || !json?.ok || !json?.item) {
        setToast({ type: "err", msg: "회원 조회 실패: " + (json?.error ?? `HTTP ${res.status}`) });
        return;
      }
      setQuickEditForm(json.item as MemberDetailLite);
      setQuickEditQ(`${json.item.name} ${json.item.member_id}`);
      setQuickEditItems([]);
    } catch (e: any) {
      setToast({ type: "err", msg: "회원 조회 오류: " + (e?.message ?? String(e)) });
    } finally {
      setQuickEditLoading(false);
    }
  }

  async function saveQuickEditMember() {
    if (!quickEditForm) return;
    const memberId = Number(quickEditForm.member_id);
    if (!Number.isFinite(memberId) || memberId <= 0) {
      setToast({ type: "err", msg: "유효한 회원번호가 필요합니다." });
      return;
    }
    if (!quickEditForm.name.trim()) {
      setToast({ type: "err", msg: "이름을 입력해 주세요." });
      return;
    }
    setQuickEditLoading(true);
    setToast(null);
    try {
      const res = await fetch("/api/members-quick-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "update",
          member_id: memberId,
          name: quickEditForm.name.trim(),
          center: quickEditForm.center.trim(),
          corporation: quickEditForm.corporation.trim() || "본사",
        }),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok || !json?.ok) {
        setToast({ type: "err", msg: "회원 수정 실패: " + (json?.error ?? `HTTP ${res.status}`) });
        return;
      }
      setToast({ type: "ok", msg: "회원 수정 완료 ✅" });
      await loadDashboard();
      if (mode === "tree") await loadTree();
      else setTreeNeedsReload(true);
    } catch (e: any) {
      setToast({ type: "err", msg: "회원 수정 오류: " + (e?.message ?? String(e)) });
    } finally {
      setQuickEditLoading(false);
    }
  }

  async function resetTestDb() {
    const ok1 = window.confirm("테스트용 DB를 초기화할까요? members + edges 데이터가 모두 삭제됩니다.");
    if (!ok1) return;
    const ok2 = window.confirm("정말 삭제합니다. 되돌릴 수 없습니다. 계속할까요?");
    if (!ok2) return;

    setResetDbLoading(true);
    setToast(null);
    try {
      const res = await fetch("/api/reset-test-db", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET" }),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok || !json?.ok) {
        setToast({ type: "err", msg: "DB 초기화 실패: " + (json?.error ?? `HTTP ${res.status}`) });
        return;
      }

      setImportResult(json);
      setTreeData(null);
      setSelectedNode(null);
      setDriveChainL([]);
      setDriveChainR([]);
      setToast({
        type: "ok",
        msg: `초기화 완료 ✅ members ${json?.deleted?.members ?? 0}건 / edges ${json?.deleted?.edges ?? 0}건 삭제`,
      });
    } catch (e: any) {
      setToast({ type: "err", msg: "DB 초기화 오류: " + (e?.message ?? String(e)) });
    } finally {
      setResetDbLoading(false);
    }
  }

  async function applySales() {
    if (!salesText.trim()) {
      setToast({ type: "err", msg: "매출 데이터(회원번호 + PV)를 붙여넣어 주세요." });
      return;
    }
    setSalesLoading(true);
    setSalesResult(null);
    setToast(null);
    try {
      const res = await fetch("/api/apply-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: salesText }),
      });
      const txt = await res.text();
      const json = txt ? JSON.parse(txt) : null;
      setSalesResult(json);
      if (!res.ok || !json?.ok) {
        setToast({ type: "err", msg: "매출 반영 실패: " + (json?.error ?? `HTTP ${res.status}`) });
        return;
      }
      if (json?.duplicated) {
        setToast({ type: "err", msg: "중복 매출로 판단되어 반영을 건너뛰었습니다." });
        return;
      }
      const tierCnt = Array.isArray(json?.tierAchieved) ? json.tierAchieved.length : 0;
      const warn = json?.warning ? ` (${json.warning})` : "";
      setToast({
        type: "ok",
        msg: `매출 반영 완료 ✅ ${json?.savedMembers ?? 0}명 갱신 / 티어 ${tierCnt}명${warn}`,
      });
      await loadDashboard();
      if (mode === "tree") await loadTree();
      else setTreeNeedsReload(true);
    } catch (e: any) {
      setToast({ type: "err", msg: "매출 반영 오류: " + (e?.message ?? String(e)) });
    } finally {
      setSalesLoading(false);
    }
  }

  async function rollbackSales(rollbackMode: "last" | "all") {
    const msg =
      rollbackMode === "all"
        ? "매출 반영 전체 이력을 모두 롤백할까요? 되돌릴 수 없습니다."
        : "최근 1회 매출 반영을 롤백할까요?";
    if (!window.confirm(msg)) return;
    setRollbackLoading(true);
    setToast(null);
    try {
      const res = await fetch("/api/sales-rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: rollbackMode, confirm: "ROLLBACK" }),
      });
      const txt = await res.text();
      const json = txt ? JSON.parse(txt) : null;
      setSalesResult(json);
      if (!res.ok || !json?.ok) {
        setToast({ type: "err", msg: "롤백 실패: " + (json?.error ?? `HTTP ${res.status}`) });
        return;
      }
      setToast({
        type: "ok",
        msg: `롤백 완료 ✅ 배치 ${json?.rolledBackBatches ?? 0}개 / 회원 ${json?.rolledBackMembers ?? 0}명`,
      });
      await loadDashboard();
      if (mode === "tree") await loadTree();
      else setTreeNeedsReload(true);
    } catch (e: any) {
      setToast({ type: "err", msg: "롤백 오류: " + (e?.message ?? String(e)) });
    } finally {
      setRollbackLoading(false);
    }
  }

  async function parsePdfFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      setToast({ type: "err", msg: "PDF 파일을 선택해 주세요." });
      return;
    }
    setPdfParseLoading(true);
    setToast(null);
    setPdfItems([]);
    setPdfParseStats(null);
    setPdfRaw("");

    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      const exRes = await fetch("/api/pdf-extract", { method: "POST", body: form });
      const exText = await exRes.text();
      const exJson = exText ? JSON.parse(exText) : null;
      if (!exRes.ok || !exJson?.ok) {
        setToast({ type: "err", msg: "PDF 추출 실패: " + (exJson?.error ?? `HTTP ${exRes.status}`) });
        return;
      }
      const raw = String(exJson.text || "");
      setPdfRaw(raw);

      const paRes = await fetch("/api/parse-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      const paText = await paRes.text();
      const paJson = paText ? JSON.parse(paText) : null;
      if (!paRes.ok || !paJson?.ok) {
        setToast({ type: "err", msg: "PDF 파싱 실패: " + (paJson?.error ?? `HTTP ${paRes.status}`) });
        return;
      }

      setPdfItems((paJson.items || []) as ParsedPdfMember[]);
      setPdfParseStats(paJson.stats || null);
      setToast({ type: "ok", msg: `PDF 파싱 완료 ✅ (${(paJson.items || []).length}명)` });
    } catch (e: any) {
      setToast({ type: "err", msg: "PDF 파싱 오류: " + (e?.message ?? String(e)) });
    } finally {
      setPdfParseLoading(false);
    }
  }

  function applyParsedToMembersText() {
    if (!pdfItems.length) {
      setToast({ type: "err", msg: "적용할 파싱 결과가 없습니다." });
      return;
    }
    const lines = pdfItems.map((m) =>
      [
        m.member_id,
        0,
        "ROOT",
        (m.name || "").trim(),
        (m.center || "-").trim(),
        (m.current_rank || m.rank || m.nominal_rank || "판매원").trim(),
        (m.last_purchase_date || "-").trim(),
        Number(m.cumulative_pv || 0),
        (m.corporation || "-").trim(),
      ].join(" | ")
    );
    setMembersText(lines.join("\n"));
    setMode("members");
    setToast({ type: "ok", msg: "파싱 결과를 멤버저장 탭에 적용했습니다." });
  }

  // ===== (C) Tree =====
  const [treeRoot, setTreeRoot] = useState("");
  const [treeDepth, setTreeDepth] = useState(8);
  const [useFullDepth, setUseFullDepth] = useState(false);
  const [treeData, setTreeData] = useState<any>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);
  const [showTreeEditor, setShowTreeEditor] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editForm, setEditForm] = useState({
    member_id: "",
    name: "",
    rank: "",
    driving_side: "L" as "L" | "R",
    cumulative_pv: "0",
    left_line_pv: "0",
    right_line_pv: "0",
    last_purchase_date: "",
  });

  const [driveAnchorId, setDriveAnchorId] = useState<number | null>(null);
  const [driveChainL, setDriveChainL] = useState<TreeNode[]>([]);
  const [driveChainR, setDriveChainR] = useState<TreeNode[]>([]);
  const [showDrivingPanel, setShowDrivingPanel] = useState(false);
  const [hideLeavingInTree, setHideLeavingInTree] = useState(true);

  const effectiveTreeRoot = useMemo(() => {
    const normalized = normalizeChildren((treeData?.tree as TreeNode) || null);
    if (!normalized) return null;
    if (!hideLeavingInTree) return normalized;
    return collapseLeavingTree(normalized);
  }, [treeData?.tree, hideLeavingInTree]);

  useEffect(() => {
    if (!authUser?.member_id) return;
    setTreeRoot(String(authUser.member_id));
    setTreeData(null);
  }, [authUser?.member_id]);

  useEffect(() => {
    if (!authUser?.member_id) return;
    loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.member_id]);

  async function submitLogin() {
    if (!/^\d{8}$/.test(loginForm.member_id.trim())) {
      setToast({ type: "err", msg: "아이디는 8자리 숫자여야 합니다." });
      return;
    }
    if (!loginForm.password.trim()) {
      setToast({ type: "err", msg: "비밀번호를 입력해 주세요." });
      return;
    }
    setToast(null);
    setLoginLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: setupMode ? "setup" : "login",
          member_id: loginForm.member_id.trim(),
          password: loginForm.password,
          remember: rememberMe,
        }),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok || !json?.ok) {
        if (setupMode && json?.code === "MEMBER_NOT_FOUND") {
          setSignupMode(true);
          setSignupForm((p) => ({ ...p, member_id: loginForm.member_id.trim() }));
          setToast({ type: "err", msg: "계보도에 없는 아이디입니다. 아래 간편가입 후 바로 시작하세요." });
          return;
        }
        setToast({ type: "err", msg: json?.error ?? `로그인 실패 (HTTP ${res.status})` });
        return;
      }
      setTreeRoot(String(json.user.member_id));
      setTreeData(null);
      setSelectedNode(null);
      setDriveChainL([]);
      setDriveChainR([]);
      setDriveAnchorId(null);
      setAuthUser(json.user);
      setToast({ type: "ok", msg: setupMode ? "비밀번호 설정 후 로그인 완료 ✅" : "로그인 완료 ✅" });
      setMode("dashboard");
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (String(msg).toLowerCase().includes("fetch failed")) {
        fallbackSubmitLoginForm();
        return;
      }
      setToast({ type: "err", msg: "로그인 오류: " + msg });
      return;
    } finally {
      setLoginLoading(false);
    }
  }

  function fallbackSubmitLoginForm() {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/auth/login-form";
    form.style.display = "none";

    const append = (name: string, value: string) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    };

    append("member_id", loginForm.member_id.trim());
    append("password", loginForm.password);
    append("remember", rememberMe ? "1" : "0");

    document.body.appendChild(form);
    form.submit();
  }

  async function submitQuickSignupFromLogin() {
    const member_id = signupForm.member_id.trim();
    const name = signupForm.name.trim();
    const center = signupForm.center.trim();
    const sponsor_id = signupForm.sponsor_id.trim();

    if (!/^\d{8}$/.test(member_id)) {
      setToast({ type: "err", msg: "아이디는 8자리 숫자여야 합니다." });
      return;
    }
    if (!name) {
      setToast({ type: "err", msg: "이름을 입력해 주세요." });
      return;
    }
    if (!loginForm.password.trim()) {
      setToast({ type: "err", msg: "비밀번호를 먼저 입력해 주세요." });
      return;
    }
    if (sponsor_id && !/^\d{8}$/.test(sponsor_id)) {
      setToast({ type: "err", msg: "스폰서 번호는 8자리 숫자여야 합니다." });
      return;
    }

    setSignupLoading(true);
    setToast(null);
    try {
      const saveRes = await fetch("/api/members-quick-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          member_id: Number(member_id),
          name,
          center: center || "센터",
          sponsor_id: sponsor_id ? Number(sponsor_id) : null,
        }),
      });
      const saveText = await saveRes.text();
      const saveJson = saveText ? JSON.parse(saveText) : null;
      if (!saveRes.ok || !saveJson?.ok) {
        setToast({ type: "err", msg: "간편가입 실패: " + (saveJson?.error ?? `HTTP ${saveRes.status}`) });
        return;
      }

      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setup",
          member_id,
          password: loginForm.password,
          remember: rememberMe,
        }),
      });
      const loginText = await loginRes.text();
      const loginJson = loginText ? JSON.parse(loginText) : null;
      if (!loginRes.ok || !loginJson?.ok) {
        setToast({ type: "err", msg: "비밀번호 설정 실패: " + (loginJson?.error ?? `HTTP ${loginRes.status}`) });
        return;
      }

      setTreeRoot(String(loginJson.user.member_id));
      setTreeData(null);
      setSelectedNode(null);
      setDriveChainL([]);
      setDriveChainR([]);
      setDriveAnchorId(null);
      setAuthUser(loginJson.user);
      setSetupMode(false);
      setSignupMode(false);
      setToast({ type: saveJson?.warning ? "err" : "ok", msg: saveJson?.warning ? `간편가입 + 로그인 완료 ✅ (${saveJson.warning})` : "간편가입 + 로그인 완료 ✅" });
      setMode("dashboard");
    } catch (e: any) {
      setToast({ type: "err", msg: "간편가입 오류: " + (e?.message ?? String(e)) });
    } finally {
      setSignupLoading(false);
    }
  }

  async function submitResetPassword() {
    if (!/^\d{8}$/.test(resetForm.member_id.trim())) {
      setToast({ type: "err", msg: "아이디는 8자리 숫자여야 합니다." });
      return;
    }
    if (resetForm.newPassword.length < 4) {
      setToast({ type: "err", msg: "새 비밀번호는 4자 이상이어야 합니다." });
      return;
    }
    if (!resetForm.adminCode.trim()) {
      setToast({ type: "err", msg: "관리자 확인코드를 입력해 주세요." });
      return;
    }
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member_id: resetForm.member_id.trim(),
        newPassword: resetForm.newPassword,
        adminCode: resetForm.adminCode,
      }),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok || !json?.ok) {
      setToast({ type: "err", msg: json?.error ?? `비밀번호 재설정 실패 (HTTP ${res.status})` });
      return;
    }
    setToast({ type: "ok", msg: "비밀번호 재설정 완료 ✅ 로그인해 주세요." });
    setResetMode(false);
    setSetupMode(false);
  }

  async function clearPasswordAccount() {
    if (!/^\d{8}$/.test(resetForm.member_id.trim())) {
      setToast({ type: "err", msg: "아이디는 8자리 숫자여야 합니다." });
      return;
    }
    if (!resetForm.adminCode.trim()) {
      setToast({ type: "err", msg: "관리자 확인코드를 입력해 주세요." });
      return;
    }
    const ok = window.confirm("이 아이디의 비밀번호를 삭제(초기화)할까요? 이후 '처음 비밀번호 설정'으로 다시 가입해야 합니다.");
    if (!ok) return;
    const res = await fetch("/api/auth/clear-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member_id: resetForm.member_id.trim(),
        adminCode: resetForm.adminCode,
      }),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok || !json?.ok) {
      setToast({ type: "err", msg: json?.error ?? `비밀번호 삭제 실패 (HTTP ${res.status})` });
      return;
    }
    setToast({ type: "ok", msg: "비밀번호 삭제(초기화) 완료 ✅" });
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthUser(null);
    setDashboardData(null);
    setTreeRoot("");
    setTreeData(null);
    setSelectedNode(null);
    setDriveChainL([]);
    setDriveChainR([]);
    setDriveAnchorId(null);
    setLoginForm({ member_id: "", password: "" });
    setToast({ type: "ok", msg: "로그아웃되었습니다." });
  }

  async function changePassword() {
    const currentPassword = window.prompt("현재 비밀번호를 입력하세요.");
    if (!currentPassword) return;
    const newPassword = window.prompt("새 비밀번호를 입력하세요. (4자 이상)");
    if (!newPassword) return;
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      setToast({ type: "err", msg: json?.error ?? `비밀번호 변경 실패 (HTTP ${res.status})` });
      return;
    }
    setToast({ type: "ok", msg: "비밀번호 변경 완료 ✅" });
  }

  async function loadDashboard() {
    if (!authUser?.member_id) return;
    setDashboardLoading(true);
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok || !json?.ok) {
        setToast({ type: "err", msg: json?.error ?? `대시보드 로드 실패 (HTTP ${res.status})` });
        return;
      }
      setDashboardData(json as DashboardData);
    } catch (e: any) {
      setToast({ type: "err", msg: "대시보드 로드 오류: " + (e?.message ?? String(e)) });
    } finally {
      setDashboardLoading(false);
    }
  }

  async function addFavorite() {
    const memberId = Number(favForm.target_member_id);
    if (!/^\d{8}$/.test(String(memberId))) {
      setToast({ type: "err", msg: "즐겨찾기 아이디는 8자리 숫자로 입력해 주세요." });
      return;
    }
    const res = await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_member_id: memberId,
        bucket: favForm.bucket,
        memo: favForm.memo,
      }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      setToast({ type: "err", msg: json?.error ?? `즐겨찾기 저장 실패 (HTTP ${res.status})` });
      return;
    }
    setFavForm({ target_member_id: "", memo: "", bucket: "DAILY" });
    setToast({ type: "ok", msg: "즐겨찾기 저장 완료 ✅" });
    await loadDashboard();
  }

  async function removeFavorite(id: number) {
    const res = await fetch("/api/favorites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      setToast({ type: "err", msg: json?.error ?? `즐겨찾기 삭제 실패 (HTTP ${res.status})` });
      return;
    }
    setToast({ type: "ok", msg: "즐겨찾기 삭제 완료" });
    await loadDashboard();
  }

  async function toggleBucket(f: DashboardFav) {
    const bucket = f.bucket === "DAILY" ? "OCCASIONAL" : "DAILY";
    const res = await fetch("/api/favorites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: f.id, bucket }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      setToast({ type: "err", msg: json?.error ?? `즐겨찾기 이동 실패 (HTTP ${res.status})` });
      return;
    }
    await loadDashboard();
  }

  async function loadTree(nextRoot?: number | string | unknown) {
    const rawRoot = (typeof nextRoot === "number" || typeof nextRoot === "string" ? String(nextRoot) : String(treeRoot)).trim();
    if (!rawRoot) {
      setToast({ type: "err", msg: "트리 root 회원번호 또는 아이디를 입력해 주세요." });
      return;
    }

    setTreeLoading(true);
    setTreeData(null);
    setToast(null);

    try {
      const safeDepth = useFullDepth ? 30 : clampDepth(treeDepth);
      if (safeDepth !== treeDepth) setTreeDepth(safeDepth);

      let root = Number.NaN;
      if (/^\d+$/.test(rawRoot)) {
        root = Number(rawRoot);
      } else {
        const { res, json } = await fetchMembers(rawRoot);
        if (!res.ok || !json?.ok) {
          setToast({ type: "err", msg: "아이디 검색 실패: " + (json?.error ?? `HTTP ${res.status}`) });
          return;
        }
        const items: Member[] = json.items ?? json.results ?? [];
        if (items.length === 0) {
          setToast({ type: "err", msg: `입력한 아이디/이름(${rawRoot})에 해당하는 회원이 없습니다.` });
          return;
        }
        root = Number(items[0].member_id);
        setTreeRoot(String(root));
      }

      if (!Number.isFinite(root) || root <= 0) {
        setToast({ type: "err", msg: "유효한 회원번호를 찾지 못했습니다. 다시 확인해 주세요." });
        return;
      }

      const res = await fetch(`/api/tree?root=${root}&depth=${safeDepth}`, { cache: "no-store" });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { ok: false, error: "Invalid JSON", raw: text };
      }

      setTreeData(json);
      if (!res.ok || !json?.ok) setToast({ type: "err", msg: "트리 로드 실패: " + (json?.error ?? `HTTP ${res.status}`) });
    } catch (e: any) {
      setTreeData({ ok: false, error: e?.message ?? String(e) });
      setToast({ type: "err", msg: "트리 로드 오류: " + (e?.message ?? String(e)) });
    } finally {
      setTreeLoading(false);
    }
  }
  function findNodeById(root: any, id: number): any | null {
    if (!root || !id) return null;
    const stack = [root];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) continue;
      if (Number(cur.id) === Number(id)) return cur;
      const kids = Array.isArray(cur.children) ? cur.children : [];
      for (const k of kids) {
        if (k?.id) stack.push(k);
      }
    }
    return null;
  }

  function toDriveNode(node: any): TreeNode {
    return {
      id: Number(node?.id ?? 0),
      name: String(node?.name ?? "(이름없음)"),
      rank: node?.rank ?? null,
      driving_side: node?.driving_side === "R" ? "R" : "L",
      cumulative_pv: Number(node?.cumulative_pv ?? 0),
      left_line_pv: Number(node?.left_line_pv ?? 0),
      right_line_pv: Number(node?.right_line_pv ?? 0),
      tier_grade: node?.tier_grade == null ? null : Number(node?.tier_grade),
      tier_points: node?.tier_points == null ? null : Number(node?.tier_points),
      tier_title: node?.tier_title ?? null,
      last_purchase_date: node?.last_purchase_date ?? null,
      is_leaving: Boolean(node?.is_leaving),
      children: [],
    };
  }

  function buildDrivingChain(rootNode: any, anchorId?: number | null, firstStepSide?: "L" | "R") {
    if (!rootNode?.id) return [];
    const startNode = anchorId ? findNodeById(rootNode, anchorId) : rootNode;
    if (!startNode?.id) return [];

    const out: TreeNode[] = [];
    let cur: any = startNode;
    let guard = 0;
    while (cur?.id && guard < 300) {
      out.push(toDriveNode(cur));
      const side: "L" | "R" = guard === 0 && firstStepSide ? firstStepSide : (cur?.driving_side === "R" ? "R" : "L");
      const kids = (cur.children || []) as any[];
      const next = kids.find((k) => k?.side === side);
      if (!next?.id) break;
      cur = next;
      guard++;
    }
    return out;
  }

  useEffect(() => {
    if (!effectiveTreeRoot?.id) {
      setDriveChainL([]);
      setDriveChainR([]);
      return;
    }
    const rootId = Number(effectiveTreeRoot.id);
    const anchor = driveAnchorId && findNodeById(effectiveTreeRoot, driveAnchorId) ? driveAnchorId : rootId;
    if (anchor !== driveAnchorId) setDriveAnchorId(anchor);
    setDriveChainL(buildDrivingChain(effectiveTreeRoot, anchor, "L"));
    setDriveChainR(buildDrivingChain(effectiveTreeRoot, anchor, "R"));
  }, [effectiveTreeRoot, driveAnchorId]);

  useEffect(() => {
    if (mode !== "tree") return;
    if (!treeNeedsReload) return;
    loadTree().finally(() => setTreeNeedsReload(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, treeNeedsReload]);

  function openEditor(node: TreeNode) {
    setSelectedNode(node);
    setShowTreeEditor(true);
    setEditForm({
      member_id: String(node.id || ""),
      name: node.name || "",
      rank: node.rank || "",
      driving_side: node.driving_side === "R" ? "R" : "L",
      cumulative_pv: String(node.cumulative_pv ?? 0),
      left_line_pv: String(node.left_line_pv ?? 0),
      right_line_pv: String(node.right_line_pv ?? 0),
      last_purchase_date: node.last_purchase_date || "",
    });
  }

  async function saveMemberFromTree() {
    const memberId = Number(editForm.member_id);
    if (!Number.isFinite(memberId) || memberId <= 0) {
      setToast({ type: "err", msg: "유효한 회원번호가 필요합니다." });
      return;
    }
    if (!editForm.name.trim()) {
      setToast({ type: "err", msg: "이름은 비워둘 수 없습니다." });
      return;
    }
    setEditLoading(true);
    setToast(null);

    try {
      const payload = {
        member_id: memberId,
        name: editForm.name.trim(),
        rank: editForm.rank.trim(),
        driving_side: editForm.driving_side,
        cumulative_pv: Number(editForm.cumulative_pv || 0),
        left_line_pv: Number(editForm.left_line_pv || 0),
        right_line_pv: Number(editForm.right_line_pv || 0),
        last_purchase_date: editForm.last_purchase_date.trim(),
      };
      const res = await fetch("/api/members-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { ok: false, error: "Invalid JSON", raw: text };
      }

      if (!res.ok || !json?.ok) {
        setToast({ type: "err", msg: "회원정보 수정 실패: " + (json?.error ?? `HTTP ${res.status}`) });
        return;
      }
      const tierText = json?.tier_result
        ? ` · 티어 ${json.tier_result.grade}급(${json.tier_result.points}점) 달성으로 좌/우PV 0 초기화`
        : "";
      if (json?.warning) setToast({ type: "err", msg: `부분 저장됨: ${json.warning}${tierText}` });
      else setToast({ type: "ok", msg: `회원정보 수정 완료 ✅${tierText}` });
      await loadTree();
    } catch (e: any) {
      setToast({ type: "err", msg: "회원정보 수정 오류: " + (e?.message ?? String(e)) });
    } finally {
      setEditLoading(false);
    }
  }


  // ===== Styles =====
  const styles = useMemo(() => {
    const pill = (active: boolean) => ({
      border: `1px solid ${t.border}`,
      background: active ? t.text : t.surface,
      color: active ? t.surface : t.text,
      padding: isMobile ? "7px 9px" : "10px 14px",
      borderRadius: 999,
      fontSize: isMobile ? 12 : 14,
      fontWeight: 800,
      cursor: "pointer",
      boxShadow: active ? t.shadow : "none",
    });
    const btn = (variant: "primary" | "ghost", disabled?: boolean) => {
      const isPrimary = variant === "primary";
      return {
        appearance: "none",
        WebkitAppearance: "none",
        border: `1px solid ${t.border}`,
        background: isPrimary ? t.text : t.surface,
        color: isPrimary ? t.surface : t.text,
        padding: "8px 12px",
        borderRadius: 10,
        fontSize: 13,
        fontWeight: 800,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        touchAction: "manipulation",
        userSelect: "none",
      } as React.CSSProperties;
    };

    return {
      page: {
        minHeight: "100vh",
        background: t.bg,
        color: t.text,
        padding: "28px 18px",
      } as React.CSSProperties,
      wrap: { maxWidth: 1060, margin: "0 auto" } as React.CSSProperties,
      headerSticky: {
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: t.bg,
        paddingTop: 8,
        paddingBottom: 8,
        borderBottom: `1px solid ${t.border}`,
      } as React.CSSProperties,
      topRow: {
        display: "flex",
        gap: 12,
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
      } as React.CSSProperties,
      title: { fontSize: isMobile ? 20 : 24, fontWeight: 900, letterSpacing: "-0.02em" } as React.CSSProperties,
      sub: { marginTop: 6, color: t.muted, fontSize: 13 } as React.CSSProperties,
      rightPills: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } as React.CSSProperties,
      navRow: {
        marginTop: 10,
        display: "flex",
        gap: 8,
        padding: 6,
        borderRadius: 12,
        border: `1px solid ${t.border}`,
        background: t.surface,
        width: "100%",
        alignItems: "center",
        justifyContent: "space-between",
      } as React.CSSProperties,
      pill,
      panel: {
        marginTop: 16,
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 18,
        padding: 18,
        boxShadow: t.shadow,
      } as React.CSSProperties,
      sectionTitle: { fontSize: 20, fontWeight: 900, marginBottom: 8 } as React.CSSProperties,
      help: { color: t.muted, fontSize: 13, lineHeight: 1.5 } as React.CSSProperties,
      grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 14 } as React.CSSProperties,
      input: {
        width: "100%",
        padding: "9px 10px",
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: t.surface,
        color: t.text,
        outline: "none",
        fontSize: isMobile ? 16 : 13,
      } as React.CSSProperties,
      listBox: {
        marginTop: 10,
        border: `1px solid ${t.border}`,
        borderRadius: 14,
        overflow: "hidden",
        background: t.surface,
      } as React.CSSProperties,
      listItem: (active: boolean) =>
        ({
          padding: "12px 12px",
          cursor: "pointer",
          background: active ? t.surface2 : t.surface,
          borderBottom: `1px solid ${t.border}`,
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          alignItems: "center",
        }) as React.CSSProperties,
      badge: {
        border: `1px solid ${t.border}`,
        borderRadius: 999,
        padding: "4px 10px",
        fontSize: 12,
        color: t.muted,
        background: t.surface,
      } as React.CSSProperties,
      btn,
      row: { display: "flex", gap: 10, alignItems: "center" } as React.CSSProperties,
      tiny: { fontSize: 12, color: t.muted } as React.CSSProperties,
      badgeBtn: {
        border: `1px solid ${t.border}`,
        borderRadius: 10,
        padding: "10px 12px",
        background: t.surface,
        color: t.text,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
      } as React.CSSProperties,
      textarea: {
        width: "100%",
        minHeight: 260,
        padding: 12,
        borderRadius: 14,
        border: `1px solid ${t.border}`,
        background: t.surface,
        color: t.text,
        outline: "none",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        fontSize: isMobile ? 16 : 12,
        lineHeight: 1.5,
      } as React.CSSProperties,
      code: {
        width: "100%",
        background: t.surface2,
        border: `1px solid ${t.border}`,
        borderRadius: 14,
        padding: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        fontSize: 12,
        whiteSpace: "pre-wrap",
        overflow: "auto",
        scrollbarGutter: "stable both-edges",
      } as React.CSSProperties,
      toastOk: {
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: 14,
        border: `1px solid ${t.border}`,
        background: theme === "light" ? "#ECFDF5" : "rgba(34,197,94,0.12)",
        color: t.text,
        fontWeight: 800,
      } as React.CSSProperties,
      toastErr: {
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: 14,
        border: `1px solid ${t.border}`,
        background: theme === "light" ? "#FEF2F2" : "rgba(248,113,113,0.12)",
        color: t.text,
        fontWeight: 800,
      } as React.CSSProperties,
    };
  }, [t, theme, isMobile]);

  return (
    <div style={styles.page}>
      <div style={styles.wrap}>
        {toast && <div style={toast.type === "ok" ? styles.toastOk : styles.toastErr}>{toast.msg}</div>}
        {authLoading ? (
          <div style={{ minHeight: "80vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ ...styles.panel, width: "100%", maxWidth: 460 }}>
              <div style={styles.sectionTitle}>로그인 확인 중...</div>
            </div>
          </div>
        ) : !authUser ? (
          <div style={{ minHeight: "80vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ ...styles.panel, width: "100%", maxWidth: 460 }}>
              <div style={styles.sectionTitle}>{resetMode ? "비밀번호 재설정" : setupMode ? "초기 비밀번호 설정" : "로그인"}</div>
              <div style={styles.help}>
                아이디는 애터미 본인 아이디(8자리 숫자)입니다.
              </div>
              {toast && <div style={toast.type === "ok" ? styles.toastOk : styles.toastErr}>{toast.msg}</div>}
              {!resetMode ? (
                <form
                  style={{ marginTop: 12, display: "grid", gap: 10 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitLogin();
                  }}
                >
                  <input
                    style={styles.input}
                    inputMode="numeric"
                    maxLength={8}
                    placeholder="아이디(8자리)"
                    value={loginForm.member_id}
                    onChange={(e) => setLoginForm((p) => ({ ...p, member_id: e.target.value.replace(/\D/g, "").slice(0, 8) }))}
                  />
                  <input
                    style={styles.input}
                    type="password"
                    placeholder="비밀번호"
                    value={loginForm.password}
                    onChange={(e) => setLoginForm((p) => ({ ...p, password: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitLogin();
                    }}
                  />
                  <label style={{ ...styles.tiny, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
                    로그인 유지
                  </label>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="submit" style={styles.btn("primary", loginLoading)} disabled={loginLoading}>
                      {loginLoading ? "처리 중..." : setupMode ? "비밀번호 설정하고 로그인" : "로그인"}
                    </button>
                    <button
                      type="button"
                      style={styles.btn("ghost")}
                      onClick={() => {
                        setSetupMode((v) => !v);
                        setSignupMode(false);
                      }}
                    >
                      {setupMode ? "로그인으로" : "처음 비밀번호 설정"}
                    </button>
                    <button type="button" style={styles.btn("ghost")} onClick={() => setResetMode(true)}>
                      비밀번호 재설정
                    </button>
                  </div>

                  {setupMode && signupMode ? (
                    <div style={{ marginTop: 8, border: `1px solid ${t.border}`, borderRadius: 12, padding: 10, background: t.surface2, display: "grid", gap: 8 }}>
                      <div style={styles.tiny}>간편가입: 계보도에 없는 아이디를 바로 생성합니다. (스폰서는 선택)</div>
                      <input
                        style={styles.input}
                        inputMode="numeric"
                        maxLength={8}
                        placeholder="아이디(8자리)"
                        value={signupForm.member_id}
                        onChange={(e) => setSignupForm((p) => ({ ...p, member_id: e.target.value.replace(/\D/g, "").slice(0, 8) }))}
                      />
                      <input
                        style={styles.input}
                        placeholder="이름"
                        value={signupForm.name}
                        onChange={(e) => setSignupForm((p) => ({ ...p, name: e.target.value }))}
                      />
                      <input
                        style={styles.input}
                        placeholder="센터"
                        value={signupForm.center}
                        onChange={(e) => setSignupForm((p) => ({ ...p, center: e.target.value }))}
                      />
                      <input
                        style={styles.input}
                        inputMode="numeric"
                        maxLength={8}
                        placeholder="스폰서 아이디(선택)"
                        value={signupForm.sponsor_id}
                        onChange={(e) => setSignupForm((p) => ({ ...p, sponsor_id: e.target.value.replace(/\D/g, "").slice(0, 8) }))}
                      />
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" style={styles.btn("primary", signupLoading)} disabled={signupLoading} onClick={submitQuickSignupFromLogin}>
                          {signupLoading ? "가입 중..." : "간편가입 후 시작"}
                        </button>
                        <button type="button" style={styles.btn("ghost")} onClick={() => setSignupMode(false)}>
                          닫기
                        </button>
                      </div>
                    </div>
                  ) : null}
                </form>
              ) : (
                <form
                  style={{ marginTop: 12, display: "grid", gap: 10 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitResetPassword();
                  }}
                >
                  <input
                    style={styles.input}
                    inputMode="numeric"
                    maxLength={8}
                    placeholder="아이디(8자리)"
                    value={resetForm.member_id}
                    onChange={(e) => setResetForm((p) => ({ ...p, member_id: e.target.value.replace(/\D/g, "").slice(0, 8) }))}
                  />
                  <input
                    style={styles.input}
                    type="password"
                    placeholder="새 비밀번호"
                    value={resetForm.newPassword}
                    onChange={(e) => setResetForm((p) => ({ ...p, newPassword: e.target.value }))}
                  />
                  <input
                    style={styles.input}
                    type="password"
                    placeholder="관리자 확인코드"
                    value={resetForm.adminCode}
                    onChange={(e) => setResetForm((p) => ({ ...p, adminCode: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitResetPassword();
                    }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="submit" style={styles.btn("primary")}>
                      재설정 실행
                    </button>
                    <button type="button" style={{ ...styles.btn("ghost"), border: "1px solid #DC2626", color: "#DC2626" }} onClick={clearPasswordAccount}>
                      비번 삭제(초기화)
                    </button>
                    <button type="button" style={styles.btn("ghost")} onClick={() => setResetMode(false)}>
                      돌아가기
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        ) : (
          <>
        <div style={styles.headerSticky}>
          <div style={styles.topRow}>
            <div>
              <button
                type="button"
                onClick={() => setMode("dashboard")}
                style={{
                  ...styles.title,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: t.text,
                }}
                title="대시보드로 이동"
              >
                ATOMY Pro v2
              </button>
            </div>

            <div style={{ ...styles.rightPills, marginLeft: "auto" }}>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={styles.btn("ghost")} onClick={changePassword}>{isMobile ? "비번변경" : "비밀번호변경"}</button>
                <button style={{ ...styles.btn("ghost"), border: "1px solid #DC2626", color: "#DC2626" }} onClick={logout}>로그아웃</button>
              </div>
            </div>
          </div>
          <div style={styles.navRow}>
            <div style={{ display: "flex", gap: 6, minWidth: 0, overflowX: "auto" }}>
              <button style={{ ...styles.pill(mode === "link"), minWidth: isMobile ? 52 : undefined }} onClick={() => setMode("link")} title="계보도연결">
                {isMobile ? (
                  <span style={{ display: "grid", justifyItems: "center", lineHeight: 1.1 }}>
                    <span style={{ fontSize: 14, fontWeight: 900 }}>L</span>
                    <span style={{ fontSize: 10, color: t.muted, fontWeight: 600 }}>연결</span>
                  </span>
                ) : (
                  "계보도연결"
                )}
              </button>
              <button style={{ ...styles.pill(mode === "members"), minWidth: isMobile ? 52 : undefined }} onClick={() => setMode("members")} title="멤버등록">
                {isMobile ? (
                  <span style={{ display: "grid", justifyItems: "center", lineHeight: 1.1 }}>
                    <span style={{ fontSize: 14, fontWeight: 900 }}>M</span>
                    <span style={{ fontSize: 10, color: t.muted, fontWeight: 600 }}>멤버</span>
                  </span>
                ) : (
                  "멤버등록"
                )}
              </button>
              <button style={{ ...styles.pill(mode === "settle"), minWidth: isMobile ? 52 : undefined }} onClick={() => setMode("settle")} title="매출반영">
                {isMobile ? (
                  <span style={{ display: "grid", justifyItems: "center", lineHeight: 1.1 }}>
                    <span style={{ fontSize: 14, fontWeight: 900 }}>S</span>
                    <span style={{ fontSize: 10, color: t.muted, fontWeight: 600 }}>매출</span>
                  </span>
                ) : (
                  "매출반영"
                )}
              </button>
              <button style={{ ...styles.pill(mode === "tree"), minWidth: isMobile ? 52 : undefined }} onClick={() => setMode("tree")} title="계보도보기">
                {isMobile ? (
                  <span style={{ display: "grid", justifyItems: "center", lineHeight: 1.1 }}>
                    <span style={{ fontSize: 14, fontWeight: 900 }}>T</span>
                    <span style={{ fontSize: 10, color: t.muted, fontWeight: 600 }}>트리</span>
                  </span>
                ) : (
                  "계보도보기"
                )}
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button style={styles.pill(theme === "light")} onClick={() => setTheme("light")}>
                {isMobile ? "L" : "Light"}
              </button>
              <button style={styles.pill(theme === "dark")} onClick={() => setTheme("dark")}>
                {isMobile ? "D" : "Dark"}
              </button>
            </div>
          </div>
        </div>

        {mode === "dashboard" && (
          <div style={styles.panel}>
            <div style={styles.sectionTitle}>📊 메인 대시보드</div>
            {dashboardLoading ? (
              <div style={styles.tiny}>불러오는 중...</div>
            ) : !dashboardData ? (
              <div style={styles.tiny}>대시보드 데이터가 없습니다.</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1.3fr 1fr", gap: 12 }}>
                  <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, background: t.surface2 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, padding: "0 10px" }}>
                      <div>
                        <div style={{ fontWeight: 900 }}>👤 내 정보</div>
                        <div style={{ marginTop: 2, fontSize: 13, color: t.muted }}>
                          {dashboardData.owner.name} #{dashboardData.owner.member_id}
                        </div>
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 900, textAlign: "right" }}>
                        본인누적PV {formatPv(dashboardData.owner.cumulative_pv)}
                      </div>
                    </div>
                    {(() => {
                      const ownerTarget = findNextTarget(dashboardData.owner.left_line_pv, dashboardData.owner.right_line_pv);
                      const ownerLRatio = clamp01(dashboardData.owner.left_line_pv / ownerTarget);
                      const ownerRRatio = clamp01(dashboardData.owner.right_line_pv / ownerTarget);
                      const ownerLDef = Math.max(0, ownerTarget - dashboardData.owner.left_line_pv);
                      const ownerRDef = Math.max(0, ownerTarget - dashboardData.owner.right_line_pv);
                      const ownerDefSum = ownerLDef + ownerRDef;
                      const ownerNear = ownerDefSum > 0 && ownerDefSum <= 50_000;
                      return (
                        <div style={{ marginTop: 10, padding: 10, border: `1px solid ${ownerNear ? "#F59E0B" : t.border}`, borderRadius: 10, background: t.surface }}>
                          <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
                            다음 기준 {formatPv(ownerTarget)} PV
                            {ownerNear ? <span style={{ marginLeft: 8, color: "#B45309" }}>임박</span> : null}
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            <div>
                              <div style={{ fontSize: 12, color: t.muted, marginBottom: 4 }}>좌 {formatPv(dashboardData.owner.left_line_pv)}</div>
                              <div style={{ height: 8, borderRadius: 999, background: t.border, overflow: "hidden" }}>
                                <div style={{ width: `${Math.round(ownerLRatio * 100)}%`, height: "100%", background: "#06B6D4" }} />
                              </div>
                            </div>
                            <div>
                              <div style={{ fontSize: 12, color: t.muted, marginBottom: 4 }}>우 {formatPv(dashboardData.owner.right_line_pv)}</div>
                              <div style={{ height: 8, borderRadius: 999, background: t.border, overflow: "hidden" }}>
                                <div style={{ width: `${Math.round(ownerRRatio * 100)}%`, height: "100%", background: "#4F46E5" }} />
                              </div>
                            </div>
                          </div>
                          <div style={{ marginTop: 6, fontSize: 12, color: ownerNear ? "#B45309" : t.muted }}>
                            부족: 좌 {formatPv(ownerLDef)} / 우 {formatPv(ownerRDef)}
                          </div>
                        </div>
                      );
                    })()}
                    <div style={{ marginTop: 8, fontSize: 13, color: t.muted, padding: "0 10px" }}>
                      반기누적PV(1~15): {formatPv(dashboardData.owner.half_month.first_half_pv)} / (16~말):{" "}
                      {formatPv(dashboardData.owner.half_month.second_half_pv)}
                    </div>
                  </div>
                  <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, background: t.surface2 }}>
                    <div style={{ fontWeight: 900 }}>💰 수당 정보</div>
                    <div style={{ marginTop: 10, fontSize: 14 }}>
                      마지막 수당발생일: <b>{dashboardData.owner.last_allowance_date ? String(dashboardData.owner.last_allowance_date).slice(0, 10) : "-"}</b>
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 14, border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, background: t.surface2 }}>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>⭐ 즐겨찾기 추가</div>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "140px 1fr 140px 88px", gap: 8 }}>
                    <input
                      style={styles.input}
                      inputMode="numeric"
                      maxLength={8}
                      placeholder="아이디 8자리"
                      value={favForm.target_member_id}
                      onChange={(e) => setFavForm((p) => ({ ...p, target_member_id: e.target.value.replace(/\D/g, "").slice(0, 8) }))}
                    />
                    <input
                      style={styles.input}
                      placeholder="메모(누군지 알아보기)"
                      value={favForm.memo}
                      onChange={(e) => setFavForm((p) => ({ ...p, memo: e.target.value }))}
                    />
                    <select
                      style={styles.input}
                      value={favForm.bucket}
                      onChange={(e) => setFavForm((p) => ({ ...p, bucket: e.target.value === "OCCASIONAL" ? "OCCASIONAL" : "DAILY" }))}
                    >
                      <option value="DAILY">Everyday</option>
                      <option value="OCCASIONAL">Someday</option>
                    </select>
                    <button style={styles.btn("primary")} onClick={addFavorite}>
                      추가
                    </button>
                  </div>
                </div>

                {[
                  { title: "☀️ Everyday", key: "daily" as const, items: dashboardData.favorites.daily },
                  { title: "🗂️ Someday", key: "occasional" as const, items: dashboardData.favorites.occasional },
                ].map((group) => (
                  <div key={group.key} style={{ marginTop: 14 }}>
                    <div style={{ ...styles.sectionTitle, fontSize: 18 }}>{group.title}</div>
                    {group.items.length === 0 ? (
                      <div style={styles.tiny}>등록된 즐겨찾기가 없습니다.</div>
                    ) : (
                      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                        {group.items.map((f) => {
                          const mobileCard = isMobile;
                          const lRatio = clamp01(f.left_line_pv / Math.max(1, f.target_threshold));
                          const rRatio = clamp01(f.right_line_pv / Math.max(1, f.target_threshold));
                          const isReady = f.부족.left <= 0 && f.부족.right <= 0 && f.부족.own <= 0;
                          const nearGapSum = Math.max(0, f.부족.left) + Math.max(0, f.부족.right);
                          const isNear = !isReady && nearGapSum <= 50_000;
                          const needOwn = f.부족.own > 0;
                          const accent = isReady ? "#16A34A" : needOwn ? "#DC2626" : isNear ? "#F59E0B" : t.border;
                          return (
                            <div key={f.id} style={{ border: `2px solid ${accent}`, borderRadius: mobileCard ? 10 : 12, padding: mobileCard ? 10 : 12, background: t.surface }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "nowrap" }}>
                                <div style={{ minWidth: 0, fontSize: mobileCard ? 12 : 13, display: "grid", gap: 2 }}>
                                  {mobileCard ? (
                                    <>
                                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                        <span style={{ fontWeight: 900 }}>{f.name}</span>
                                        <span style={{ color: t.muted }}>|</span>
                                        <span style={styles.tiny}>{f.member_id}</span>
                                      </div>
                                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", color: t.muted }}>
                                        <span>본인PV {formatPv(f.cumulative_pv)}</span>
                                        <span>|</span>
                                        <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                          메모 {f.memo || "-"}
                                        </span>
                                      </div>
                                    </>
                                  ) : (
                                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                      <span style={{ fontWeight: 900 }}>{f.name}</span>
                                      <span style={{ color: t.muted }}>|</span>
                                      <span style={styles.tiny}>{f.member_id}</span>
                                      <span style={{ color: t.muted }}>|</span>
                                      <span>본인PV {formatPv(f.cumulative_pv)}</span>
                                      <span style={{ color: t.muted }}>|</span>
                                      <span style={{ ...styles.tiny, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        메모 {f.memo || "-"}
                                      </span>
                                    </div>
                                  )}
                                </div>
                                {mobileCard ? (
                                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    <button
                                      style={{
                                        ...styles.btn("ghost"),
                                        height: 28,
                                        padding: "0 8px",
                                        fontSize: 11,
                                      }}
                                      onClick={() => toggleBucket(f)}
                                    >
                                      {f.bucket === "DAILY" ? "🗂️로 교체" : "☀️로 교체"}
                                    </button>
                                    <button
                                      style={{
                                        ...styles.btn("ghost"),
                                        border: `1px solid ${t.text}`,
                                        color: t.text,
                                        height: 28,
                                        width: 28,
                                        padding: 0,
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        fontSize: 13,
                                        fontWeight: 900,
                                      }}
                                      onClick={() => removeFavorite(f.id)}
                                      title="삭제"
                                      aria-label="삭제"
                                    >
                                      ×
                                    </button>
                                  </div>
                                ) : (
                                  <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
                                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                      <span
                                        style={{
                                          fontSize: 12,
                                          fontWeight: 900,
                                          borderRadius: 999,
                                          height: 32,
                                          padding: "0 10px",
                                          border: `1px solid ${accent}`,
                                          color: accent,
                                          background: t.surface2,
                                          display: "inline-flex",
                                          alignItems: "center",
                                        }}
                                      >
                                        {isReady ? "달성가능" : needOwn ? "본인PV 부족" : isNear ? "임박" : "진행중"}
                                      </span>
                                      <button
                                        style={{
                                          ...styles.btn("ghost"),
                                          border: `1px solid ${t.text}`,
                                          color: t.text,
                                          height: 32,
                                          width: 32,
                                          padding: 0,
                                          display: "inline-flex",
                                          alignItems: "center",
                                          justifyContent: "center",
                                          fontSize: 14,
                                          fontWeight: 900,
                                        }}
                                        onClick={() => removeFavorite(f.id)}
                                        title="삭제"
                                        aria-label="삭제"
                                      >
                                        ×
                                      </button>
                                    </div>
                                    <button
                                      style={{
                                        ...styles.btn("ghost"),
                                        height: 32,
                                        padding: "0 10px",
                                        fontSize: 12,
                                      }}
                                      onClick={() => toggleBucket(f)}
                                    >
                                      {f.bucket === "DAILY" ? "Someday로 교체" : "Everyday로 교체"}
                                    </button>
                                  </div>
                                )}
                              </div>
                              <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: mobileCard ? 6 : 8 }}>
                                <div>
                                  <div style={{ fontSize: 12, color: t.muted, marginBottom: 4 }}>좌PV {formatPv(f.left_line_pv)}</div>
                                  <div style={{ height: mobileCard ? 8 : 10, borderRadius: 999, background: t.border, overflow: "hidden" }}>
                                    <div style={{ width: `${Math.round(lRatio * 100)}%`, height: "100%", background: "#06B6D4" }} />
                                  </div>
                                </div>
                                <div>
                                  <div style={{ fontSize: 12, color: t.muted, marginBottom: 4 }}>우PV {formatPv(f.right_line_pv)}</div>
                                  <div style={{ height: mobileCard ? 8 : 10, borderRadius: 999, background: t.border, overflow: "hidden" }}>
                                    <div style={{ width: `${Math.round(rRatio * 100)}%`, height: "100%", background: "#4F46E5" }} />
                                  </div>
                                </div>
                              </div>
                              <div style={{ marginTop: 6, fontSize: mobileCard ? 12 : 13, color: t.muted }}>
                                마지막수당발생일: {f.last_allowance_date ? String(f.last_allowance_date).slice(0, 10) : "-"}
                              </div>
                              <div style={{ marginTop: 8, fontSize: mobileCard ? 12 : 13, fontWeight: 800, color: isNear ? "#B45309" : t.text }}>
                                {formatPv(f.target_threshold)} 달성까지 좌 {formatPv(f.부족.left)} / 우 {formatPv(f.부족.right)} 부족
                              </div>
                              {needOwn ? (
                                <div style={{ marginTop: 4, fontSize: mobileCard ? 12 : 13, color: "#DC2626", fontWeight: 800 }}>
                                  본인PV 300,000까지 {formatPv(f.부족.own)} 부족
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {mode === "link" && (
          <div style={styles.panel}>
            <div style={styles.sectionTitle}>🔗 계보도 연결</div>
            <div style={styles.help}>- 이름/회원번호 검색 → 선택 → L/R 연결</div>
            <div style={styles.help}>- 이름 또는 회원번호(ID) 검색 가능합니다.</div>

            <div style={styles.grid2}>
              {/* Sponsor */}
              <div>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>스폰서</div>
                <input style={styles.input} value={sponsorQ} onChange={(e) => setSponsorQ(e.target.value)} placeholder="예: 홍길동 / 12345678" />
                <div style={styles.listBox}>
                  {sponsorItems.length === 0 ? (
                    <div style={{ padding: 12, color: t.muted }}>검색 결과 없음</div>
                  ) : (
                    sponsorItems.map((m) => (
                      <div
                        key={m.member_id}
                        style={styles.listItem(sponsorSel?.member_id === m.member_id)}
                        onClick={() => setSponsorSel(m)}
                      >
                        <div style={{ fontWeight: 800 }}>{m.name}</div>
                        <span style={styles.badge}>{m.member_id}</span>
                      </div>
                    ))
                  )}
                </div>
                <div style={{ marginTop: 8, color: t.muted, fontSize: 12 }}>
                  선택됨: <b style={{ color: t.text }}>{sponsorSel ? `${sponsorSel.name} (${sponsorSel.member_id})` : "없음"}</b>
                </div>
              </div>

              {/* Partner */}
              <div>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>파트너</div>
                <input
                  ref={partnerInputRef}
                  style={styles.input}
                  value={partnerQ}
                  onChange={(e) => setPartnerQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveLink();
                    }
                  }}
                  placeholder="예: 홍길동 / 12345678 (Enter 저장)"
                />
                <div style={styles.listBox}>
                  {partnerItems.length === 0 ? (
                    <div style={{ padding: 12, color: t.muted }}>검색 결과 없음</div>
                  ) : (
                    partnerItems.map((m) => (
                      <div
                        key={m.member_id}
                        style={styles.listItem(partnerSel?.member_id === m.member_id)}
                        onClick={() => setPartnerSel(m)}
                      >
                        <div style={{ fontWeight: 800 }}>{m.name}</div>
                        <span style={styles.badge}>{m.member_id}</span>
                      </div>
                    ))
                  )}
                </div>
                <div style={{ marginTop: 8, color: t.muted, fontSize: 12 }}>
                  선택됨: <b style={{ color: t.text }}>{partnerSel ? `${partnerSel.name} (${partnerSel.member_id})` : "없음"}</b>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={styles.row}>
                <div style={{ fontWeight: 900 }}>{isMobile ? "방향" : "연결 방향"}</div>
                <button style={styles.btn(side === "L" ? "primary" : "ghost")} onClick={() => setSide("L")}>
                  {isMobile ? "L" : "L (좌)"}
                </button>
                <button style={styles.btn(side === "R" ? "primary" : "ghost")} onClick={() => setSide("R")}>
                  {isMobile ? "R" : "R (우)"}
                </button>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8, color: t.muted, fontSize: 13 }}>
                  <input type="checkbox" checked={lineDriveMode} onChange={(e) => setLineDriveMode(e.target.checked)} />
                  라인타기
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={styles.btn("primary")} onClick={() => saveLink()}>
                  저장
                </button>
              </div>
            </div>
            <div style={{ ...styles.tiny, marginTop: 8 }}>
              - 라인타기 체크 시: 저장 후 파트너가 자동으로 스폰서로 이동하고, 커서는 파트너 입력창에 유지됩니다.
            </div>

            {isDev ? (
              <div style={{ marginTop: 12 }}>
                <div style={styles.sectionTitle}>📋 결과</div>
                <pre style={styles.code}>{safeJsonStringify(linkResult)}</pre>
                <div style={{ marginTop: 10, color: t.muted, fontSize: 12 }}>DEBUG</div>
                <pre style={styles.code}>{safeJsonStringify(debug)}</pre>
              </div>
            ) : null}
          </div>
        )}

        {mode === "members" && (
          <div style={styles.panel}>
            <div style={styles.sectionTitle}>⚡ 간편 신규 등록</div>
            <div style={styles.help}>- 신규 1~2명은 여기서 바로 등록 + 스폰서 자동 연결 가능합니다. (좌/우는 빈 자리 자동 선택)</div>
            <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(4, minmax(140px, 1fr))", gap: 8 }}>
              <input
                style={styles.input}
                inputMode="numeric"
                maxLength={8}
                value={quickCreate.member_id}
                onChange={(e) => setQuickCreate((p) => ({ ...p, member_id: e.target.value.replace(/\D/g, "").slice(0, 8) }))}
                placeholder="회원번호 8자리"
              />
              <input
                style={styles.input}
                value={quickCreate.name}
                onChange={(e) => setQuickCreate((p) => ({ ...p, name: e.target.value }))}
                placeholder="이름"
              />
              <input
                style={styles.input}
                value={quickCreate.center}
                onChange={(e) => setQuickCreate((p) => ({ ...p, center: e.target.value }))}
                placeholder="센터"
              />
              <input
                style={styles.input}
                inputMode="numeric"
                maxLength={8}
                value={quickCreate.sponsor_id}
                onChange={(e) => setQuickCreate((p) => ({ ...p, sponsor_id: e.target.value.replace(/\D/g, "").slice(0, 8) }))}
                placeholder="스폰서 8자리(선택)"
              />
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
              <button style={styles.btn("primary", quickCreateLoading)} disabled={quickCreateLoading} onClick={quickCreateMember}>
                {quickCreateLoading ? "등록 중..." : "신규 가입 등록"}
              </button>
            </div>

            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${t.border}` }}>
              <div style={styles.sectionTitle}>🛠 회원 빠른 수정</div>
              <div style={styles.help}>- 이름 파싱이 잘못된 회원은 여기서 검색 후 바로 수정하세요.</div>
              <div style={{ marginTop: 10 }}>
                <input
                  style={styles.input}
                  value={quickEditQ}
                  onChange={(e) => setQuickEditQ(e.target.value)}
                  placeholder="회원번호 또는 이름 검색"
                />
              </div>
              {quickEditItems.length > 0 && (
                <div style={{ ...styles.listBox, marginTop: 8, maxHeight: 180, overflow: "auto" }}>
                  {quickEditItems.map((m) => (
                    <div
                      key={`qe-${m.member_id}`}
                      style={styles.listItem(quickEditForm?.member_id === m.member_id)}
                      onClick={() => selectQuickEditMember(m)}
                    >
                      <div>{m.name}</div>
                      <span style={styles.badge}>{m.member_id}</span>
                    </div>
                  ))}
                </div>
              )}
              {quickEditForm && (
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(4, minmax(120px, 1fr))", gap: 8 }}>
                  <input style={styles.input} value={String(quickEditForm.member_id)} readOnly />
                  <input
                    style={styles.input}
                    value={quickEditForm.name}
                    onChange={(e) => setQuickEditForm((p) => (p ? { ...p, name: e.target.value } : p))}
                    placeholder="이름"
                  />
                  <input
                    style={styles.input}
                    value={quickEditForm.center || ""}
                    onChange={(e) => setQuickEditForm((p) => (p ? { ...p, center: e.target.value } : p))}
                    placeholder="센터"
                  />
                  <input
                    style={styles.input}
                    value={quickEditForm.corporation || ""}
                    onChange={(e) => setQuickEditForm((p) => (p ? { ...p, corporation: e.target.value } : p))}
                    placeholder="법인"
                  />
                </div>
              )}
              <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
                <button style={styles.btn("primary", quickEditLoading || !quickEditForm)} disabled={quickEditLoading || !quickEditForm} onClick={saveQuickEditMember}>
                  {quickEditLoading ? "저장 중..." : "수정 저장"}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${t.border}` }}>
            <div style={styles.sectionTitle}>📄 PDF 파서</div>
            <div style={styles.help}>
              - PDF 업로드 → 자동 파싱(이름/아이디/명목/등급/누적PV/센터/법인/매출일)
            </div>
            <div style={styles.help}>- 수정 후 멤버저장 탭으로 보낼 수 있습니다.</div>
            <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input
                ref={pdfFileInputRef}
                type="file"
                accept="application/pdf"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  parsePdfFiles(e.target.files);
                }}
              />
              <button type="button" style={styles.btn("primary")} onClick={() => pdfFileInputRef.current?.click()}>
                PDF 파일 선택
              </button>
              <button type="button" style={styles.btn("ghost")} onClick={applyParsedToMembersText} disabled={!pdfItems.length}>
                파싱결과 멤버저장으로 보내기
              </button>
              {pdfParseLoading && <span style={styles.tiny}>파싱 중...</span>}
              {!pdfParseLoading && pdfParseStats && <span style={styles.tiny}>parsed: {pdfParseStats?.parsed ?? 0}</span>}
            </div>

            <div style={{ marginTop: 12, maxHeight: 420, overflow: "auto", scrollbarGutter: "stable both-edges", border: `1px solid ${t.border}`, borderRadius: 12 }}>
              {pdfItems.length === 0 ? (
                <div style={{ padding: 12, color: t.muted }}>아직 파싱 결과가 없습니다.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: t.surface2 }}>
                      {["아이디", "이름", "명목", "등급", "누적PV", "센터", "법인", "매출일", "신뢰도"].map((h) => (
                        <th key={h} style={{ borderBottom: `1px solid ${t.border}`, textAlign: "left", padding: "8px 10px" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pdfItems.map((m, idx) => (
                      <tr key={`${m.member_id}-${idx}`}>
                        <td style={{ borderBottom: `1px solid ${t.border}`, padding: 8 }}>
                          <input
                            style={styles.input}
                            value={m.member_id}
                            onChange={(e) =>
                              setPdfItems((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, member_id: Number(e.target.value || 0) } : x))
                              )
                            }
                          />
                        </td>
                        <td style={{ borderBottom: `1px solid ${t.border}`, padding: 8 }}>
                          <input
                            style={styles.input}
                            value={m.name || ""}
                            onChange={(e) => setPdfItems((prev) => prev.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))}
                          />
                        </td>
                        <td style={{ borderBottom: `1px solid ${t.border}`, padding: 8 }}>
                          <input
                            style={styles.input}
                            value={m.nominal_rank || m.rank || ""}
                            onChange={(e) =>
                              setPdfItems((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, nominal_rank: e.target.value, rank: e.target.value } : x))
                              )
                            }
                          />
                        </td>
                        <td style={{ borderBottom: `1px solid ${t.border}`, padding: 8 }}>
                          <input
                            style={styles.input}
                            value={m.current_rank || ""}
                            onChange={(e) =>
                              setPdfItems((prev) => prev.map((x, i) => (i === idx ? { ...x, current_rank: e.target.value } : x)))
                            }
                          />
                        </td>
                        <td style={{ borderBottom: `1px solid ${t.border}`, padding: 8 }}>
                          <input
                            style={styles.input}
                            value={m.cumulative_pv ?? 0}
                            onChange={(e) =>
                              setPdfItems((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, cumulative_pv: Number(e.target.value || 0) } : x))
                              )
                            }
                          />
                        </td>
                        <td style={{ borderBottom: `1px solid ${t.border}`, padding: 8 }}>
                          <input
                            style={styles.input}
                            value={m.center || ""}
                            onChange={(e) => setPdfItems((prev) => prev.map((x, i) => (i === idx ? { ...x, center: e.target.value } : x)))}
                          />
                        </td>
                        <td style={{ borderBottom: `1px solid ${t.border}`, padding: 8 }}>
                          <input
                            style={styles.input}
                            value={m.corporation || ""}
                            onChange={(e) =>
                              setPdfItems((prev) => prev.map((x, i) => (i === idx ? { ...x, corporation: e.target.value } : x)))
                            }
                          />
                        </td>
                        <td style={{ borderBottom: `1px solid ${t.border}`, padding: 8 }}>
                          <input
                            style={styles.input}
                            value={m.last_purchase_date || ""}
                            onChange={(e) =>
                              setPdfItems((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, last_purchase_date: e.target.value || null } : x))
                              )
                            }
                          />
                        </td>
                        <td style={{ borderBottom: `1px solid ${t.border}`, padding: 8, color: t.muted }}>
                          {Math.round(Number(m.confidence || 0) * 100)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {pdfRaw ? (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: "pointer", color: t.muted }}>추출 원문 보기</summary>
                <pre style={{ ...styles.code, marginTop: 8, maxHeight: 260 }}>{pdfRaw}</pre>
              </details>
            ) : null}
            </div>
          </div>
        )}

        {mode === "members" && (
          <div style={styles.panel}>
            <div style={styles.sectionTitle}>🧾 멤버 일괄 등록</div>
            <div style={styles.help}>
              - 예시: <span style={{ fontFamily: "ui-monospace" }}>12345678 | 0 | ROOT | 홍길동 | 센터 | 등급 | 20XX-XX-XX | 300000</span>
            </div>

            <div style={{ marginTop: 12 }}>
              <textarea style={styles.textarea} value={membersText} onChange={(e) => setMembersText(e.target.value)} />
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button style={styles.btn("primary")} onClick={importMembers}>
                멤버 저장
              </button>
              {isDev ? (
                <button
                  style={{ ...styles.btn("ghost", resetDbLoading), border: "1px solid #DC2626", color: "#DC2626" }}
                  onClick={resetTestDb}
                  disabled={resetDbLoading}
                >
                  {resetDbLoading ? "초기화 중..." : "DB 초기화(테스트용)"}
                </button>
              ) : null}
              <button
                style={styles.btn("ghost")}
                onClick={() => {
                  setMembersText("");
                  setImportResult(null);
                }}
              >
                초기화
              </button>
            </div>

            {isDev ? (
              <div style={{ marginTop: 12 }}>
                <div style={styles.sectionTitle}>📋 결과</div>
                <pre style={styles.code}>{safeJsonStringify(importResult)}</pre>
              </div>
            ) : null}
          </div>
        )}

        {mode === "settle" && (
          <div style={styles.panel}>
            <div style={styles.sectionTitle}>💸 일매출 반영 (자동 누적)</div>
            <div style={styles.help}>
              - 애터미 &gt; 마이페이지 &gt; 하위매출에서 행을 드래그 복사해서 그대로 붙여넣으면 됩니다.
              <br />
              - 회원 본인 PV + 상위 스폰서 라인 PV(좌/우)가 자동 누적됩니다.
              <br />
              - 티어 조건 달성 시 해당 회원의 좌/우 라인PV는 자동으로 0으로 초기화됩니다.
            </div>

            <div style={{ marginTop: 12 }}>
              <textarea
                style={{ ...styles.textarea, minHeight: 220 }}
                value={salesText}
                onChange={(e) => setSalesText(e.target.value)}
                placeholder={"예시(하위매출 복사-붙여넣기)\n좌\n판매\n일반\n20XX-XX-XX\n본사\n12345678\n홍길동\n1122334455667788\n50,000"}
              />
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button style={styles.btn("primary", salesLoading)} disabled={salesLoading} onClick={applySales}>
                {salesLoading ? (isMobile ? "실행..." : "반영 중...") : (isMobile ? "실행" : "매출 반영 실행")}
              </button>
              <button style={styles.btn("ghost", rollbackLoading)} disabled={rollbackLoading} onClick={() => rollbackSales("last")}>
                {rollbackLoading ? (isMobile ? "롤백..." : "롤백 중...") : (isMobile ? "1회롤백" : "최근 1회 롤백")}
              </button>
              <button
                style={{ ...styles.btn("ghost", rollbackLoading), border: "1px solid #DC2626", color: "#DC2626" }}
                disabled={rollbackLoading}
                onClick={() => rollbackSales("all")}
              >
                {isMobile ? "전체롤백" : "전체 롤백"}
              </button>
              <button style={styles.btn("ghost")} onClick={() => setSalesText("")}>
                {isMobile ? "초기화" : "입력 비우기"}
              </button>
            </div>

            {isDev ? (
              <div style={{ marginTop: 12 }}>
                <div style={styles.sectionTitle}>📋 결과</div>
                <pre style={styles.code}>{safeJsonStringify(salesResult)}</pre>
              </div>
            ) : null}
          </div>
        )}

        {mode === "tree" && (
          <div style={styles.panel}>
            <div style={styles.sectionTitle}>🌳 트리 보기</div>
            <div style={{ ...styles.tiny, marginTop: 6 }}>- 좌/우 라인PV는 현재 수동 관리 모드입니다. 회원정보 수정에서 직접 입력하세요.</div>
            <div style={{ ...styles.tiny, marginTop: 4 }}>- 티어 조건 달성 시 해당 회원의 좌/우 라인PV는 자동으로 0으로 초기화됩니다.</div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span style={{ ...styles.badge, border: "1px solid #7C3AED", color: "#7C3AED" }}>자가소비회원</span>
              <span style={{ ...styles.badge, border: "1px solid #16A34A", color: "#16A34A" }}>회원</span>
              <span style={{ ...styles.badge, border: "1px solid #2563EB", color: "#2563EB" }}>에이전트 이상</span>
              <span style={{ ...styles.badge, border: "1px solid #DC2626", color: "#DC2626" }}>탈퇴예정</span>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input
                style={{ ...styles.input, width: isMobile ? 104 : 180, textAlign: "center" }}
                value={treeRoot}
                onChange={(e) => setTreeRoot(e.target.value)}
                placeholder={isMobile ? "ID/이름" : "예: 12345678 / 홍길동"}
              />
              <input
                style={{ ...styles.input, width: isMobile ? 54 : 90, textAlign: "center" }}
                type="number"
                min={1}
                max={30}
                step={1}
                value={treeDepth}
                disabled={useFullDepth}
                onChange={(e) => setTreeDepth(clampDepth(Number(e.target.value)))}
              />
              <span style={styles.tiny}>{isMobile ? "D" : "Depth (1~30)"}</span>
              <button type="button" style={styles.btn(useFullDepth ? "primary" : "ghost")} onClick={() => setUseFullDepth((v) => !v)}>
                {isMobile ? "ALL" : "최대 30Depth"}
              </button>
              <button type="button" style={styles.btn(hideLeavingInTree ? "primary" : "ghost")} onClick={() => setHideLeavingInTree((v) => !v)}>
                {isMobile ? "탈퇴숨김" : hideLeavingInTree ? "탈퇴 숨김 ON" : "탈퇴 숨김 OFF"}
              </button>
              <button
                style={{ ...styles.btn("primary", treeLoading), minWidth: isMobile ? 42 : 84, padding: isMobile ? "8px 10px" : "8px 12px" }}
                disabled={treeLoading}
                onClick={() => loadTree()}
                title="트리 불러오기"
                aria-label="트리 불러오기"
              >
                {treeLoading ? (isMobile ? "…" : "불러오는 중...") : (isMobile ? "↵" : "불러오기")}
              </button>
              {treeNeedsReload && mode === "tree" && <span style={{ ...styles.tiny, color: "#DC2626" }}>매출 반영됨 · 트리 새로고침 필요</span>}
            </div>

            {treeData?.ok && treeData?.tree?.id ? (
              <div style={{ marginTop: 8, ...styles.tiny }}>
                ROOT #{treeData.tree.id} · 본인PV {formatPv(treeData.tree.cumulative_pv)} · 좌PV {formatPv(treeData.tree.left_line_pv)} · 우PV{" "}
                {formatPv(treeData.tree.right_line_pv)}
              </div>
            ) : null}

            <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                style={styles.btn(driveAnchorId === Number(treeData?.tree?.id ?? 0) ? "primary" : "ghost")}
                onClick={() => {
                  const rootId = Number(treeData?.tree?.id ?? 0);
                  if (rootId) {
                    setDriveAnchorId(rootId);
                    setShowDrivingPanel(true);
                  }
                }}
                disabled={!treeData?.ok}
              >
                ROOT 기준
              </button>
              <button
                type="button"
                style={styles.btn((selectedNode?.id || driveAnchorId) ? "primary" : "ghost")}
                onClick={() => {
                  const targetId = Number(selectedNode?.id || driveAnchorId || 0);
                  if (targetId > 0) {
                    setDriveAnchorId(targetId);
                    setShowDrivingPanel(true);
                    const nextRoot = String(targetId);
                    setTreeRoot(nextRoot);
                    loadTree(targetId);
                  }
                }}
                disabled={!selectedNode?.id && !driveAnchorId}
              >
                선택 멤버 기준
              </button>
              <span style={styles.tiny}>트리에서 멤버 클릭 후 ‘선택 멤버 기준’을 누르면 그 사람부터 자동 드라이빙 라인을 계산합니다.</span>
            </div>

            <div style={{ marginTop: 10, padding: 12, border: `1px solid ${t.border}`, borderRadius: 12, background: t.surface2 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ ...styles.sectionTitle, marginBottom: 0 }}>✏️ 트리 회원정보 수정</div>
                <button type="button" style={styles.btn("ghost")} onClick={() => setShowTreeEditor((v) => !v)}>
                  {showTreeEditor ? "접기" : "펼치기"}
                </button>
              </div>
              {!showTreeEditor ? (
                <div style={styles.tiny}>접혀 있습니다. 필요할 때 펼쳐서 수정하세요.</div>
              ) : selectedNode ? (
                <>
                  <div style={{ ...styles.tiny, marginBottom: 10 }}>
                    선택 멤버: {selectedNode.name} #{selectedNode.id}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
                    <input style={styles.input} value={editForm.member_id} readOnly />
                    <input
                      style={styles.input}
                      value={editForm.name}
                      onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                      placeholder="이름"
                    />
                    <input
                      style={styles.input}
                      value={editForm.rank}
                      onChange={(e) => setEditForm((prev) => ({ ...prev, rank: e.target.value }))}
                      placeholder="등급"
                    />
                    <select
                      style={styles.input}
                      value={editForm.driving_side}
                      onChange={(e) => setEditForm((prev) => ({ ...prev, driving_side: e.target.value === "R" ? "R" : "L" }))}
                    >
                      <option value="L">드라이빙 L</option>
                      <option value="R">드라이빙 R</option>
                    </select>
                    <input
                      style={styles.input}
                      type="number"
                      min={0}
                      value={editForm.cumulative_pv}
                      onChange={(e) => setEditForm((prev) => ({ ...prev, cumulative_pv: e.target.value }))}
                      placeholder="누적PV"
                    />
                    <input
                      style={styles.input}
                      type="number"
                      min={0}
                      value={editForm.left_line_pv}
                      onChange={(e) => setEditForm((prev) => ({ ...prev, left_line_pv: e.target.value }))}
                      placeholder="좌 라인PV"
                    />
                    <input
                      style={styles.input}
                      type="number"
                      min={0}
                      value={editForm.right_line_pv}
                      onChange={(e) => setEditForm((prev) => ({ ...prev, right_line_pv: e.target.value }))}
                      placeholder="우 라인PV"
                    />
                    <input
                      style={{ ...styles.input, minWidth: 0 }}
                      type="date"
                      value={editForm.last_purchase_date}
                      onChange={(e) => setEditForm((prev) => ({ ...prev, last_purchase_date: e.target.value }))}
                    />
                  </div>
                  <div style={{ ...styles.tiny, marginTop: 8 }}>
                    탈퇴예정 기준: 마지막구매일 12개월 경과 또는 (누적PV 0 + 구매일 6개월 경과/없음)
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <button type="button" style={styles.btn("primary", editLoading)} disabled={editLoading} onClick={saveMemberFromTree}>
                      {editLoading ? "저장 중..." : "회원정보 저장"}
                    </button>
                  </div>
                </>
              ) : (
                <div style={styles.tiny}>트리에서 멤버 노드를 클릭하면 여기서 수정할 수 있습니다.</div>
              )}
            </div>

            <div style={{ marginTop: 14 }}>
              {treeData?.ok && effectiveTreeRoot ? (
                <>
                  <div style={{ ...styles.help, marginBottom: 10 }}>
                    nodes: <b style={{ color: t.text }}>{treeData?.stats?.nodes ?? "-"}</b> / edges:{" "}
                    <b style={{ color: t.text }}>{treeData?.stats?.edges ?? "-"}</b>
                  </div>
                  <TreeBinaryView
                    root={effectiveTreeRoot as TreeNode}
                    depth={useFullDepth ? 30 : clampDepth(treeDepth)}
                    theme={t}
                    isMobile={isMobile}
                    onNodeClick={(node) => {
                      if (!node?.id) return;
                      openEditor(node);
                      setDriveAnchorId(node.id);
                    }}
                  />
                </>
              ) : treeData ? (
                <pre style={styles.code}>{safeJsonStringify(treeData)}</pre>
              ) : (
                <div style={{ color: t.muted, padding: 10 }}>아직 트리를 불러오지 않았습니다.</div>
              )}
            </div>

            {(driveChainL.length > 0 || driveChainR.length > 0) && (
              <div style={{ marginTop: 10, padding: 12, border: `1px solid ${t.border}`, borderRadius: 12, background: t.surface2 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={styles.tiny}>드라이빙 라인 · 기준 ID #{driveAnchorId ?? treeData?.tree?.id ?? "-"}</div>
                  <button type="button" style={styles.btn("ghost")} onClick={() => setShowDrivingPanel((v) => !v)}>
                    {showDrivingPanel ? "드라이빙 접기" : "드라이빙 펼치기"}
                  </button>
                </div>
                {showDrivingPanel && (
                  <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
                    {[
                      { title: `좌 시작 ${driveChainL.length}명`, chain: driveChainL, startSide: "L" as const },
                      { title: `우 시작 ${driveChainR.length}명`, chain: driveChainR, startSide: "R" as const },
                    ].map((box, boxIdx) => (
                      <div key={boxIdx} style={{ border: `1px solid ${t.border}`, borderRadius: 10, background: t.surface }}>
                        <div style={{ ...styles.tiny, padding: "8px 10px", borderBottom: `1px solid ${t.border}` }}>{box.title}</div>
                        <div style={{ maxHeight: 210, overflowY: "auto", display: "grid", gridTemplateColumns: "1fr", gap: 8, padding: 8 }}>
                          {box.chain.map((n: any, i: number) => (
                            <button
                              key={(n?.id ?? 0) + "-" + i}
                              type="button"
                              style={{ ...styles.badgeBtn, width: "100%", justifyContent: "flex-start" }}
                              onClick={() => {
                                const nextRoot = String(n?.id ?? "");
                                if (!nextRoot) return;
                                setTreeRoot(nextRoot);
                                loadTree(Number(nextRoot));
                              }}
                              title="이 노드를 root로 설정"
                            >
                              <b style={{ marginRight: 6, minWidth: 18 }}>{i === 0 ? "" : String(i)}</b>
                              {n?.name || "(이름없음)"} <span style={{ opacity: 0.7, marginLeft: 6 }}>#{n?.id ?? 0}</span>
                              <span style={{ opacity: 0.7, marginLeft: 8 }}>
                                ({i === 0 ? (n?.driving_side || "L") : `${i === 1 ? box.startSide : box.chain[i - 1]?.driving_side || "L"} | ${n?.driving_side || "L"}`})
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}
