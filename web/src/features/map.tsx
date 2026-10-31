import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { Node } from "@/components/ai-elements/node";
import { Panel } from "@/components/ai-elements/panel";
import { splitLabel, type State } from "@/lib/api";
import { BaseEdge, getNodesBounds, useStore, useInternalNode, type CoordinateExtent, type EdgeProps, type Edge as FlowEdge, type InternalNode, type Node as FlowNode, type NodeProps } from "@xyflow/react";
import { ArrowLeftRightIcon, FolderGit2Icon, LinkIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Dot } from "./projects";

// What is linked to what: the person's projects and the projects linked to them, placed on a grid so the links are
// short and do not cross. Project cards show activity and humans. A linked project that is not
// the viewer's shows by name only: nothing else of it crosses a link.

type Data = Record<string, unknown>;
type ProjectData = State["projects"][number] & { me: string } & Data;
type ForeignData = { name: string } & Data;

// Grid cells: wide enough for a card and the gap around it.
const CELL = { w: 410, h: 320 };

function ProjectNode({ data }: NodeProps<FlowNode<ProjectData>>) {
  const live = data.sessions.filter((s) => s.online).length;
  const sessions = [...data.sessions].sort((a, b) => Number(b.online) - Number(a.online)).slice(0, 3);
  const others = data.humans.filter((h) => h !== data.me);
  return (
    <Node handles={{ target: true, source: true }} className="map-project hidden-handles">
      <div className="map-project-heading">
        <span className="map-project-symbol"><FolderGit2Icon /></span>
        <div className="min-w-0"><p className="eyebrow truncate">{data.owner ?? "Shared project"}</p><h3 title={data.id} className="truncate text-base font-semibold">{data.id.split("/").slice(-1)[0]}</h3></div>
      </div>
      <div className="map-project-activity"><Dot on={live > 0} /><span>{live ? `${live} agent${live === 1 ? "" : "s"} online` : "No agents online"}</span>{data.roles.length > 0 && <span className="ml-auto text-muted-foreground">{data.roles.filter((r) => r.holder).length} roles held</span>}</div>
      <div className="map-project-sessions">
        {sessions.map((s) => <div key={s.label} className="flex min-w-0 items-center justify-between gap-3"><span title={s.label} className="truncate">{splitLabel(s.label).name}</span><span className="shrink-0 text-[10px] text-muted-foreground">{s.online ? "Online" : "Away"}</span></div>)}
        {data.sessions.length > 3 && <p className="text-muted-foreground">+{data.sessions.length - 3} more agents</p>}
        {!data.sessions.length && <p className="text-muted-foreground">Ready for your first agent.</p>}
      </div>
      <div className="map-project-people"><span className="eyebrow">Humans</span><span title={data.humans.join(", ")} className="truncate">{data.humans.includes(data.me) ? "You" : ""}{others.length ? `${data.humans.includes(data.me) ? " + " : ""}${others.length === 1 ? others[0] : `${others.length} others`}` : ""}</span></div>
    </Node>
  );
}

function ForeignNode({ data }: NodeProps<FlowNode<ForeignData>>) {
  return (
    <Node handles={{ target: true, source: false }} className="map-project map-project-foreign hidden-handles">
      <div className="map-project-heading"><span className="map-project-symbol"><LinkIcon /></span><div className="min-w-0"><p className="eyebrow">Linked project</p><h3 title={data.name} className="truncate text-sm font-semibold">{data.name}</h3></div></div>
      <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground">Messages can travel both ways. Humans and activity stay private.</p>
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
  const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  return (
    <g className="group">
      <title>{(data as { label?: string } | undefined)?.label}</title>
      <path d={path} fill="none" stroke="transparent" strokeWidth={14} />
      <BaseEdge id={id} path={path} style={{ stroke: "var(--map-link)", strokeWidth: 1.5 }} />
      <g transform={`translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2}) rotate(${angle})`} aria-hidden="true">
        <circle r="13" fill="var(--sidebar)" />
        <path d="M -7 -3 H 7 L 3 -7 M 7 3 H -7 L -3 7" fill="none" stroke="var(--map-link)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
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
    ...foreign.map((f) => ({ id: `p:${f}`, type: "foreign", position: { x: pos.get(f)!.x + 24, y: pos.get(f)!.y + 40 }, data: { name: f } })),
  ];
  const edges = pairs.map(([a, b]) => ({ id: `l:${a}|${b}`, source: `p:${a}`, target: `p:${b}`, type: "link", data: { label: `${a} ↔ ${b}` } }));
  return { nodes, edges, foreign: foreign.length };
}

// Use measured cards, including linked projects, so tall cards stay inside the boundary.
// React Flow centres an extent smaller than the viewport, and clamps panning at larger zooms.
const PAN_PADDING = 80;
function MapBoundary({ onChange }: { onChange: (extent: CoordinateExtent) => void }) {
  // Controlled nodes do not receive measured dimensions unless the caller applies
  // onNodesChange. Read the internal lookup, which always has the rendered sizes.
  const bounds = useStore((s) => {
    const nodes = [...s.nodeLookup.values()];
    return nodes.some((n) => !n.measured.width || !n.measured.height) ? null : getNodesBounds(nodes, { nodeLookup: s.nodeLookup });
  }, (a, b) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height));
  const { x = 0, y = 0, width = 0, height = 0 } = bounds ?? {};
  const measured = bounds !== null;
  useEffect(() => {
    if (measured) onChange([[x - PAN_PADDING, y - PAN_PADDING], [x + width + PAN_PADDING, y + height + PAN_PADDING]]);
  }, [measured, x, y, width, height, onChange]);
  return null;
}

export function LinkMap({ state }: { state: State }) {
  const { nodes, edges, foreign } = useMemo(() => graph(state), [state]);
  const [extent, setExtent] = useState<CoordinateExtent>();
  return (
    <div className="map-surface h-[70vh] min-h-[420px] overflow-hidden rounded-lg border">
      <Canvas nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} panOnDrag selectionOnDrag={false} nodesConnectable={false}
        translateExtent={extent} nodesDraggable={false} deleteKeyCode={null} proOptions={{ hideAttribution: true }} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} minZoom={0.2}>
        <MapBoundary onChange={setExtent} />
        <Controls showInteractive={false} />
        <Panel position="top-left" className="map-caption px-3 py-2 text-muted-foreground text-xs">
          {state.projects.length} project{state.projects.length === 1 ? "" : "s"} · {edges.length} connection{edges.length === 1 ? "" : "s"}
          {foreign > 0 && ` · ${foreign} linked project${foreign === 1 ? "" : "s"} of others (dashed)`}
        </Panel>
        <Panel position="bottom-right" className="map-caption flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><ArrowLeftRightIcon className="size-3.5" /> Connections work both ways</Panel>
      </Canvas>
    </div>
  );
}
