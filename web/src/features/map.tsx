import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { Node, NodeContent, NodeDescription, NodeHeader, NodeTitle } from "@/components/ai-elements/node";
import { Panel } from "@/components/ai-elements/panel";
import { Badge } from "@/components/ui/badge";
import { splitLabel, type State } from "@/lib/api";
import { BaseEdge, useInternalNode, type EdgeProps, type Edge as FlowEdge, type InternalNode, type Node as FlowNode, type NodeProps } from "@xyflow/react";
import { LinkIcon, UserIcon } from "lucide-react";
import { useMemo } from "react";
import { Dot } from "./projects";

// What is linked to what: the person's projects and the projects linked to them, placed on a grid so the links are
// short and do not cross. People other than the viewer show as pills in their projects. A linked project that is not
// the viewer's shows by name only: nothing else of it crosses a link.

type Data = Record<string, unknown>;
type ProjectData = State["projects"][number] & { me: string } & Data;
type ForeignData = { name: string } & Data;

// Grid cells: wide enough for a card and the gap around it.
const CELL = { w: 360, h: 270 };

function ProjectNode({ data }: NodeProps<FlowNode<ProjectData>>) {
  const live = data.sessions.filter((s) => s.online).length;
  const held = data.roles.filter((r) => r.holder);
  const others = data.humans.filter((h) => h !== data.me);
  return (
    <Node handles={{ target: true, source: true }} className="w-72 hidden-handles">
      <NodeHeader>
        <NodeTitle className="text-sm">{data.id}</NodeTitle>
        <NodeDescription>{live} of {data.sessions.length} sessions online · {held.length}/{data.roles.length} roles held</NodeDescription>
        {others.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {others.map((h) => <Badge key={h} variant="outline" className="rounded-full"><UserIcon />{h}</Badge>)}
          </div>
        )}
      </NodeHeader>
      <NodeContent className="flex flex-col gap-1.5 text-xs">
        {data.sessions.slice(0, 6).map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <Dot on={s.online} />
            <span className="truncate">{splitLabel(s.label).name}</span>
            {s.roles.map((r) => <Badge key={r} variant="secondary" className="h-4 px-1 text-[10px]">{r}</Badge>)}
          </div>
        ))}
        {data.sessions.length > 6 && <div className="text-muted-foreground">and {data.sessions.length - 6} more</div>}
        {!data.sessions.length && <div className="text-muted-foreground">Nobody is live.</div>}
      </NodeContent>
    </Node>
  );
}

function ForeignNode({ data }: NodeProps<FlowNode<ForeignData>>) {
  return (
    <Node handles={{ target: true, source: false }} className="w-56 border-dashed hidden-handles">
      <NodeHeader className="bg-transparent">
        <NodeTitle className="flex items-center gap-2 text-sm"><LinkIcon className="size-4" />{data.name}</NodeTitle>
        <NodeDescription>Linked, not yours: messages cross, nothing else.</NodeDescription>
      </NodeHeader>
    </Node>
  );
}

// A node's centre, and where the line from it towards a point leaves the node's box.
function centre(n: InternalNode) {
  return { x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2 };
}

function border(n: InternalNode, toward: { x: number; y: number }) {
  const c = centre(n);
  const w = (n.measured.width ?? 0) / 2, h = (n.measured.height ?? 0) / 2;
  const dx = toward.x - c.x, dy = toward.y - c.y;
  const t = Math.min(dx ? w / Math.abs(dx) : Infinity, dy ? h / Math.abs(dy) : Infinity, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

// A link: a straight line between the two cards' borders, along their centres. (React Flow draws an edge only between
// handles, so the cards keep theirs, invisible; the line ignores them.)
function LinkEdge({ id, source, target, data }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const a = border(s, centre(t)), b = border(t, centre(s));
  const path = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  return (
    <g className="group">
      <title>{(data as { label?: string } | undefined)?.label}</title>
      <path d={path} fill="none" stroke="transparent" strokeWidth={14} />
      <BaseEdge id={id} path={path} className="transition-[stroke-width] group-hover:stroke-[3px]!" style={{ stroke: "var(--primary)", strokeWidth: 1.5 }} />
      <circle fill="var(--primary)" r="3">
        <animateMotion dur="3s" path={path} repeatCount="indefinite" />
      </circle>
    </g>
  );
}

const nodeTypes = { project: ProjectNode, foreign: ForeignNode };
const edgeTypes = { link: LinkEdge };

// ---------------------------------------------------------------- layout

type P = { x: number; y: number };

function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

// Whether segment a-b passes through the card in the cell at c.
function through(a: P, b: P, c: P): boolean {
  const vx = b.x - a.x, vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((c.x - a.x) * vx + (c.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.abs(a.x + vx * t - c.x) < CELL.w * 0.42 && Math.abs(a.y + vy * t - c.y) < CELL.h * 0.38;
}

// Seeded, so the same projects always get the same picture.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Each node gets one cell of a grid. The cost is the total length of the links plus penalties for links that cross or
// run through a card; a few thousand random moves and swaps, each kept when it does not cost more, settle a graph
// this small.
export function place(ids: string[], pairs: [string, string][]): Map<string, P> {
  const n = ids.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.5)));
  const rows = Math.max(1, Math.ceil(n / cols) + (n > 2 ? 1 : 0));
  const cells: P[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: c * CELL.w, y: r * CELL.h });
  const index = new Map(ids.map((id, i) => [id, i]));
  const edges = pairs.map(([a, b]) => [index.get(a)!, index.get(b)!] as const);
  const linked = new Set(edges.flat());
  const at = ids.map((_, i) => i); // node i sits in cell at[i]
  const cost = (): number => {
    const p = (i: number) => cells[at[i]!]!;
    let total = 0;
    for (const [a, b] of edges) {
      total += Math.hypot((p(a).x - p(b).x) / CELL.w, (p(a).y - p(b).y) / CELL.h);
      for (let k = 0; k < n; k++) if (k !== a && k !== b && through(p(a), p(b), p(k))) total += 4;
    }
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const [a, b] = edges[i]!, [c, d] = edges[j]!;
        if (a !== c && a !== d && b !== c && b !== d && segmentsCross(p(a), p(b), p(c), p(d))) total += 3;
      }
    }
    // Unlinked projects go to the end of the grid rather than between linked ones.
    for (let i = 0; i < n; i++) if (!linked.has(i)) total += at[i]! * 0.01;
    return total;
  };
  const rand = rng(n * 7919 + pairs.length);
  let best = cost();
  for (let step = 0; step < 4000; step++) {
    const i = Math.floor(rand() * n);
    const cell = Math.floor(rand() * cells.length);
    const j = at.indexOf(cell);
    const before = at[i]!;
    at[i] = cell;
    if (j >= 0) at[j] = before;
    const c = cost();
    if (c <= best) best = c;
    else {
      at[i] = before;
      if (j >= 0) at[j] = cell;
    }
  }
  return new Map(ids.map((id, i) => [id, cells[at[i]!]!]));
}

export function graph(state: State): { nodes: FlowNode<Data>[]; edges: FlowEdge[]; foreign: number } {
  const mine = new Set(state.projects.map((p) => p.id));
  const foreign = [...new Set(state.projects.flatMap((p) => p.links).filter((l) => !mine.has(l)))].sort();
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const p of state.projects) {
    for (const l of p.links) {
      const key = [p.id, l].sort().join("|");
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push([p.id, l]);
      }
    }
  }
  const pos = place([...state.projects.map((p) => p.id), ...foreign], pairs);
  const nodes: FlowNode<Data>[] = [
    ...state.projects.map((p) => ({ id: `p:${p.id}`, type: "project", position: pos.get(p.id)!, data: { ...p, me: state.human } as ProjectData })),
    // Smaller cards: centred in their cell.
    ...foreign.map((f) => ({ id: `p:${f}`, type: "foreign", position: { x: pos.get(f)!.x + 32, y: pos.get(f)!.y + 40 }, data: { name: f } })),
  ];
  const edges = pairs.map(([a, b]) => ({ id: `l:${a}|${b}`, source: `p:${a}`, target: `p:${b}`, type: "link", data: { label: `${a} ↔ ${b}` } }));
  return { nodes, edges, foreign: foreign.length };
}

export function LinkMap({ state }: { state: State }) {
  const { nodes, edges, foreign } = useMemo(() => graph(state), [state]);
  return (
    <div className="h-[75vh] min-h-[420px] overflow-hidden rounded-lg border">
      <Canvas nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} panOnDrag selectionOnDrag={false} nodesConnectable={false}
        nodesDraggable={false} deleteKeyCode={null} proOptions={{ hideAttribution: true }} fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.2}>
        <Controls showInteractive={false} />
        <Panel position="top-left" className="px-3 py-2 text-muted-foreground text-xs">
          {state.projects.length} projects · {edges.length} link{edges.length === 1 ? "" : "s"}
          {foreign > 0 && ` · ${foreign} linked project${foreign === 1 ? "" : "s"} of others (dashed)`}
        </Panel>
      </Canvas>
    </div>
  );
}
