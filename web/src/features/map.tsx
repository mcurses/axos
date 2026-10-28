import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { Edge } from "@/components/ai-elements/edge";
import { Node, NodeContent, NodeDescription, NodeHeader, NodeTitle } from "@/components/ai-elements/node";
import { Panel } from "@/components/ai-elements/panel";
import { Badge } from "@/components/ui/badge";
import { splitLabel, type State } from "@/lib/api";
import { BaseEdge, getBezierPath, Position, useInternalNode, type EdgeProps, type Edge as FlowEdge, type Node as FlowNode, type NodeProps } from "@xyflow/react";
import { LinkIcon, UserIcon } from "lucide-react";
import { useMemo } from "react";
import { Dot } from "./projects";

// What is linked to what: people (left) in projects (middle), projects linked to each other, and linked projects that
// are not this person's (right; only their name crosses a link, nothing of their sessions).

type Data = Record<string, unknown>;
type HumanData = { name: string; projects: number };
type ProjectData = State["projects"][number] & Data;
type ForeignData = { name: string };

const COL = { human: 0, project: 380, foreign: 980 };
const GAP = 36;

function HumanNode({ data }: NodeProps<FlowNode<HumanData>>) {
  return (
    <Node handles={{ target: false, source: true }} className="w-48">
      <NodeHeader>
        <NodeTitle className="flex items-center gap-2 text-sm"><UserIcon className="size-4" />{data.name}</NodeTitle>
        <NodeDescription>{data.projects} project{data.projects === 1 ? "" : "s"}</NodeDescription>
      </NodeHeader>
    </Node>
  );
}

function ProjectNode({ data }: NodeProps<FlowNode<ProjectData>>) {
  const live = data.sessions.filter((s) => s.online).length;
  const held = data.roles.filter((r) => r.holder);
  return (
    <Node handles={{ target: true, source: true }} className="w-72">
      <NodeHeader>
        <NodeTitle className="text-sm">{data.id}</NodeTitle>
        <NodeDescription>{live} of {data.sessions.length} sessions online · {held.length}/{data.roles.length} roles held</NodeDescription>
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
    <Node handles={{ target: true, source: false }} className="w-56 border-dashed">
      <NodeHeader className="bg-transparent">
        <NodeTitle className="flex items-center gap-2 text-sm"><LinkIcon className="size-4" />{data.name}</NodeTitle>
        <NodeDescription>Linked, not yours: messages cross, nothing else.</NodeDescription>
      </NodeHeader>
    </Node>
  );
}

// A link between two projects. Both in the middle column: an arc on their right. Otherwise: right side to left side.
// Each end sits at its own height on the node (data.sOff, data.tOff), so links leaving one project stay apart.
function LinkEdge({ id, source, target, data }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const { sOff = 0, tOff = 0, label = "" } = (data ?? {}) as { sOff?: number; tOff?: number; label?: string };
  const [sw, sh, th, tw] = [s.measured.width ?? 0, s.measured.height ?? 0, t.measured.height ?? 0, t.measured.width ?? 0];
  const sx = s.internals.positionAbsolute.x + sw;
  const sy = s.internals.positionAbsolute.y + sh / 2 + sOff;
  const sameColumn = Math.abs(s.internals.positionAbsolute.x - t.internals.positionAbsolute.x) < 10;
  const ty = t.internals.positionAbsolute.y + th / 2 + tOff;
  let path: string;
  if (sameColumn) {
    const tx = t.internals.positionAbsolute.x + tw;
    const bow = 40 + Math.abs(sy - ty) * 0.45;
    path = `M ${sx} ${sy} C ${sx + bow} ${sy}, ${tx + bow} ${ty}, ${tx} ${ty}`;
  } else {
    [path] = getBezierPath({ sourceX: sx, sourceY: sy, sourcePosition: Position.Right, targetX: t.internals.positionAbsolute.x, targetY: ty, targetPosition: Position.Left });
  }
  return (
    <g className="group">
      <title>{label}</title>
      <path d={path} fill="none" stroke="transparent" strokeWidth={14} />
      <BaseEdge id={id} path={path} className="transition-[stroke-width] group-hover:stroke-[3px]!" style={{ stroke: "var(--primary)", strokeWidth: 1.5 }} />
      <circle fill="var(--primary)" r="3">
        <animateMotion dur="3s" path={path} repeatCount="indefinite" />
      </circle>
    </g>
  );
}

const nodeTypes = { human: HumanNode, project: ProjectNode, foreign: ForeignNode };
const edgeTypes = { member: Edge.Temporary, link: LinkEdge };

// Heights before React Flow has measured anything, so columns start out without overlaps.
const projectHeight = (p: State["projects"][number]) => 74 + 16 + Math.max(1, Math.min(p.sessions.length, 6) + (p.sessions.length > 6 ? 1 : 0)) * 22;

export function graph(state: State): { nodes: FlowNode<Data>[]; edges: FlowEdge[] } {
  const nodes: FlowNode<Data>[] = [];
  const edges: FlowEdge[] = [];
  const mine = new Set(state.projects.map((p) => p.id));
  let y = 0;
  for (const p of state.projects) {
    nodes.push({ id: `p:${p.id}`, type: "project", position: { x: COL.project, y }, data: p as ProjectData });
    y += projectHeight(p) + GAP;
  }
  const total = y;
  const humans = [...new Set(state.projects.flatMap((p) => p.humans))].sort((a, b) => (a === state.human ? -1 : b === state.human ? 1 : a.localeCompare(b)));
  humans.forEach((h, i) => {
    const count = state.projects.filter((p) => p.humans.includes(h)).length;
    nodes.push({ id: `h:${h}`, type: "human", position: { x: COL.human, y: (total / Math.max(humans.length, 1)) * i }, data: { name: h, projects: count } });
  });
  for (const p of state.projects) {
    for (const h of p.humans) edges.push({ id: `m:${h}:${p.id}`, source: `h:${h}`, target: `p:${p.id}`, type: "member" });
  }
  const foreign = [...new Set(state.projects.flatMap((p) => p.links).filter((l) => !mine.has(l)))].sort();
  foreign.forEach((f, i) => nodes.push({ id: `p:${f}`, type: "foreign", position: { x: COL.foreign, y: (total / Math.max(foreign.length, 1)) * i }, data: { name: f } }));
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const p of state.projects) {
    for (const l of p.links) {
      const key = [p.id, l].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([p.id, l]);
    }
  }
  // Ends per node, ordered by where the other end is, spread 12 px apart around the node's middle.
  const order = new Map(nodes.map((n, i) => [n.id.slice(2), n.position.y + i / 1000]));
  const ends = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    ends.set(a, [...(ends.get(a) ?? []), b]);
    ends.set(b, [...(ends.get(b) ?? []), a]);
  }
  const offset = (node: string, other: string) => {
    const list = [...ends.get(node)!].sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0));
    return (list.indexOf(other) - (list.length - 1) / 2) * 12;
  };
  for (const [a, b] of pairs) {
    edges.push({ id: `l:${a}|${b}`, source: `p:${a}`, target: `p:${b}`, type: "link", data: { sOff: offset(a, b), tOff: offset(b, a), label: `${a} ↔ ${b}` } });
  }
  return { nodes, edges };
}

export function LinkMap({ state }: { state: State }) {
  const { nodes, edges } = useMemo(() => graph(state), [state]);
  const links = edges.filter((e) => e.type === "link").length;
  return (
    <div className="h-[75vh] min-h-[420px] overflow-hidden rounded-lg border">
      <Canvas nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} panOnDrag selectionOnDrag={false} nodesConnectable={false} nodesDraggable={false}
        deleteKeyCode={null} proOptions={{ hideAttribution: true }} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.2}>
        <Controls showInteractive={false} />
        <Panel position="top-left" className="px-3 py-2 text-muted-foreground text-xs">
          {state.projects.length} projects · {links} link{links === 1 ? "" : "s"} · dashed: who is in which project
        </Panel>
      </Canvas>
    </div>
  );
}
