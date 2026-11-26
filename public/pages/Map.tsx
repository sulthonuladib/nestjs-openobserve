/**
 * Map — how the applications in this project talk to each other.
 *
 * **What an edge is, and what it is not.** There is no parent-service field on
 * the wire: a span knows its parent *span*, not the service that span belongs to
 * across a process boundary. So the collector infers the graph from trace ids —
 * two applications that appear in the same trace, in causal order (each
 * application's earliest hop, ordered by the agent's own `calledAt`), are one
 * edge, counted once per trace. That is the honest inference available, and the
 * page says so in one line rather than drawing a call graph we did not measure
 * per span. A trace that only ever touched one application produces no edge at
 * all, which is why a quiet map usually means "traffic has not crossed a service
 * boundary yet", not "the map is broken".
 *
 * **Nodes carry two different kinds of work.** Requests and jobs are separate
 * counts — a job is not a request, and summing them into one "traffic" number
 * would make a worker's queue throughput look like HTTP traffic. Errors are the
 * third count, and the only one coloured: an application that is busy and failing
 * is the reason to open this page during an incident.
 *
 * **Why the drawing is hand-rolled.** There is no graph library in this repo and
 * one is not worth adding for five nodes. The layout is deterministic: break
 * cycles with a DFS, assign each node the longest path from a root (so callers sit
 * left of callees), order each column by activity, and draw cubic edges with
 * arrowheads. Same payload in, same picture out — a graph that reshuffles on every
 * poll is unreadable. Under the drawing there is a table of the same edges, so the
 * page is still useful at a small width, and a projection screen is not the only
 * place this data is legible.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  type ServiceMapEdge,
  type ServiceMapNode,
  type ServiceMapResult,
} from "../api";
import { formatCount, formatNumber, windowFor, type TimeRangeId } from "../format";
import { colors, fontMono, labelCaps, tabular } from "../theme";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval, useShell } from "../components/shell";

export interface MapProps {
  appId?: string;
  id?: string;
  range?: TimeRangeId;
  navigate?: (to: string) => void;
  search?: string;
}

export function Map({ appId, id, range = "1h", navigate }: MapProps) {
  // The shell passes `navigate`; the hook keeps the page working on its own.
  const routerNavigate = useNavigate();
  // `""` is "All applications", a real view. The legacy application path names a
  // concrete scope, so a bookmark keeps it instead of widening to the project.
  const scope = appId || id || "";
  return <MapView scope={scope} range={range} go={navigate ?? routerNavigate} />;
}

function MapView({
  scope,
  range,
  go,
}: {
  /** `""` for the whole project; an application id otherwise. */
  scope: string;
  range: TimeRangeId;
  go: (to: string) => void;
}) {
  const refetchInterval = useLiveInterval();
  const { apps } = useShell();
  const unscoped = scope === "";
  const scopeName = unscoped
    ? null
    : (apps.find((entry) => entry.id === scope)?.name ?? scope);

  const graph = useQuery({
    queryKey: ["service-map", scope, range],
    queryFn: () => api.serviceMap(scope, windowFor(range)),
    refetchInterval,
  });

  const data = graph.data;
  // Names of applications the scoped payload does not return a node for.
  // `/telemetry/map` builds its edge labels from the node set, and under an
  // application filter that set is one element — so the *other* end of a real
  // edge comes back named by its id. The shell already has every application's
  // name for the switcher, so nothing extra is fetched to turn a uuid back into
  // `orders-worker`.
  const knownNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const app of apps) names[app.id] = app.name;
    return names;
  }, [apps]);
  const edges = useMemo(() => {
    const nameFor = (id: string, given: string) =>
      given && given !== id ? given : (knownNames[id] ?? given ?? id);
    return (data?.edges ?? []).map((edge) => ({
      ...edge,
      fromName: nameFor(edge.from, edge.fromName),
      toName: nameFor(edge.to, edge.toName),
    }));
  }, [data?.edges, knownNames]);
  const shaped = data ? buildGraph(data, knownNames) : null;
  const totalTraces = edges.reduce((sum, edge) => sum + edge.traces, 0);
  // Only count a node as "in the picture" if it either ran something or is on an
  // edge; the rest are applications that exist but did nothing in this window.
  const drawn = shaped?.drawn ?? [];
  const quiet = shaped?.quiet ?? [];

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Map"
        description={
          unscoped
            ? "How the project's applications hand work to each other, inferred from traces that cross a service boundary."
            : `${scopeName} — the applications it shares traces with, in either direction.`
        }
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Stat label="Applications" value={String(drawn.length)} />
            <Stat label="Links" value={String(edges.length)} />
            <Stat label="Cross-service traces" value={formatCount(totalTraces)} />
          </Stack>
        }
      />

      {graph.isError && (
        <Alert severity="error">
          The map could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(graph.error)}
          </Box>
        </Alert>
      )}

      {graph.isLoading ? (
        <Paper sx={{ p: 2 }}>
          <Skeleton variant="rounded" height={280} />
        </Paper>
      ) : !data || drawn.length === 0 ? (
        <EmptyState
          title="No applications in this window."
          hint="The map is built from applications the agent has linked to this project. Point a NestJS app at the collector and its first execution appears in this window."
        />
      ) : (
        <>
          <Paper sx={{ overflow: "hidden" }}>
            {/* No arrows is a *state of the data*, not an error: the applications
                still have their counts, so they are drawn. The note sits above
                the boxes and says what would have to happen for an arrow to
                appear. */}
            {edges.length === 0 && (
              <Box
                sx={{
                  px: 2,
                  py: 1.75,
                  borderBottom: `1px solid ${colors.border}`,
                  backgroundColor: "rgba(255,255,255,0.012)",
                }}
              >
                <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
                  No cross-service traces in this window.
                </Typography>
                <Typography sx={{ mt: 0.5, fontSize: 11.5, color: "text.disabled", maxWidth: 760 }}>
                  An application with no edge to another application can run all it likes. A
                  link appears once one trace carries two applications — a request reaches a
                  second service, or a job consumer inherits the producer&apos;s trace id. That is
                  the only thing that creates an arrow.
                </Typography>
              </Box>
            )}
            <ServiceGraph drawn={drawn} edges={edges} scope={scope} go={go} range={range} />
            <Stack
              direction="row"
              spacing={1.5}
              sx={{
                px: 2,
                py: 1.25,
                borderTop: `1px solid ${colors.border}`,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <LegendItem label="application" />
              <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
                {edges.length === 0
                  ? "Each box is one application, with its requests, jobs and errors in this window. Jobs are counted apart from requests: a consumer is not HTTP traffic."
                  : "Arrowheads show causal order; labels on the arrows are the number of traces that carried that hop. Links are inferred from shared trace ids, not measured per span."}
              </Typography>
            </Stack>
          </Paper>

          {edges.length > 0 && <EdgeTable edges={edges} go={go} />}

          {quiet.length > 0 && (
            <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
              Not drawn — no requests, jobs or cross-service traces in this window:{" "}
              {quiet.map((node) => node.name).join(", ")}.
            </Typography>
          )}
        </>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// The drawing
// ---------------------------------------------------------------------------

/** A node ready to place: the payload's node, plus anything only an edge knows. */
interface GraphNode {
  id: string;
  name: string;
  requests: number;
  jobs: number;
  errors: number;
  /**
   * True when the node exists only as an edge endpoint. That happens under an
   * application filter: the server returns one node but still returns the edges
   * that touch it, so the other end has a name and no counts. Drawing it as an
   * empty application instead of hiding the edge is the honest option — the link
   * is real, the numbers are simply out of scope.
   */
  outsideScope: boolean;
}

interface ShapedGraph {
  /** Nodes with activity or an edge — what the drawing contains. */
  drawn: GraphNode[];
  /** Applications that exist but did nothing in the window. */
  quiet: GraphNode[];
}

function buildGraph(
  payload: ServiceMapResult,
  knownNames: Record<string, string> = {},
): ShapedGraph {
  // A plain object keyed by id rather than a `Map`: this module's component is
  // named `Map`, which shadows the global constructor at module scope.
  const byId: Record<string, GraphNode> = {};
  for (const node of payload.nodes) {
    byId[node.applicationId] = toGraphNode(node);
  }

  // Edge endpoints outside the returned node set are added, not dropped: in a
  // scoped view they are exactly the other half of the picture.
  for (const edge of payload.edges) {
    if (!byId[edge.from]) {
      byId[edge.from] = {
        id: edge.from,
        name: knownNames[edge.from] ?? edge.fromName,
        requests: 0,
        jobs: 0,
        errors: 0,
        outsideScope: true,
      };
    }
    if (!byId[edge.to]) {
      byId[edge.to] = {
        id: edge.to,
        name: knownNames[edge.to] ?? edge.toName,
        requests: 0,
        jobs: 0,
        errors: 0,
        outsideScope: true,
      };
    }
  }

  const onAnEdge: Record<string, true> = {};
  for (const edge of payload.edges) {
    onAnEdge[edge.from] = true;
    onAnEdge[edge.to] = true;
  }

  const drawn: GraphNode[] = [];
  const quiet: GraphNode[] = [];
  for (const id of Object.keys(byId)) {
    const node = byId[id];
    if (!node) continue;
    const activity = node.requests + node.jobs;
    if (activity > 0 || onAnEdge[id] || node.outsideScope) drawn.push(node);
    else quiet.push(node);
  }
  // Stable order: activity first, then name. The layer pass re-orders within a
  // column anyway, but the input order has to be deterministic for that to be.
  drawn.sort((a, b) => b.requests + b.jobs - (a.requests + a.jobs) || a.name.localeCompare(b.name));
  quiet.sort((a, b) => a.name.localeCompare(b.name));

  return { drawn, quiet };
}

function toGraphNode(node: ServiceMapNode): GraphNode {
  return {
    id: node.applicationId,
    name: node.applicationName,
    requests: node.requests,
    jobs: node.jobs,
    errors: node.errors,
    outsideScope: false,
  };
}

interface Placement {
  node: GraphNode;
  layer: number;
  x: number;
  y: number;
}

function ServiceGraph({
  drawn,
  edges,
  scope,
  go,
  range,
}: {
  drawn: GraphNode[];
  edges: ServiceMapEdge[];
  /** The active application, highlighted in the drawing. */
  scope: string;
  go: (to: string) => void;
  range: TimeRangeId;
}) {
  const layout = layoutGraph(drawn, edges);
  const nodeW = 176;
  const nodeH = 66;
  const gapX = 88;
  const gapY = 18;
  const padX = 16;
  const padY = 18;

  const columns = layout.layers.length;
  const widest = Math.max(1, ...layout.layers.map((column) => column.length));
  // The drawing scales with its container — the reference's map fills its card
  // and a 736px-wide graph floating in a 1,100px panel reads as an empty card.
  // The height floor is small on purpose: a three-node chain is a short, wide
  // picture, and padding it out to a tall box only adds blank space.
  const width = Math.max(560, padX * 2 + columns * nodeW + Math.max(0, columns - 1) * gapX);
  const height = Math.max(120, padY * 2 + widest * nodeH + Math.max(0, widest - 1) * gapY);

  const placed: Record<string, Placement> = {};
  layout.layers.forEach((column, layerIndex) => {
    const x = padX + layerIndex * (nodeW + gapX);
    // Centre each column against the tallest one, so a single-caller column sits
    // level with the middle of its callees rather than at the top.
    const offset = ((widest - column.length) * (nodeH + gapY)) / 2;
    column.forEach((node, row) => {
      placed[node.id] = { node, layer: layerIndex, x, y: padY + offset + row * (nodeH + gapY) };
    });
  });

  const maxTraces = Math.max(1, ...edges.map((edge) => edge.traces));

  return (
    <Box sx={{ overflowX: "auto", p: 1.5 }}>
      <Box
        component="svg"
        viewBox={`0 0 ${width} ${height}`}
        sx={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label="Application map: applications as boxes, cross-service traces as arrows"
      >
        <defs>
          <marker
            id="map-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" fill={colors.borderStrong} />
          </marker>
          <marker
            id="map-arrow-hot"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" fill={colors.accentText} />
          </marker>
        </defs>

        {/* Edges first, so a node always covers the end of an arrow. */}
        {edges.map((edge) => {
          const from = placed[edge.from];
          const to = placed[edge.to];
          if (!from || !to) return null;
          // A back edge only exists when two applications appear in traces in
          // both orders. It is drawn anyway — the arrow still shows the causal
          // direction — but it is routed around the boxes, on the left.
          const backwards = to.layer <= from.layer;
          const x1 = backwards ? from.x : from.x + nodeW;
          const y1 = from.y + nodeH / 2;
          const x2 = backwards ? to.x + nodeW : to.x;
          const y2 = to.y + nodeH / 2;
          const bend = Math.max(36, Math.abs(x2 - x1) / 2);
          const c1 = x1 + (backwards ? -bend : bend);
          const c2 = x2 - (backwards ? -bend : bend);
          const path = `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;
          // Cubic at t=0.5 — where the label sits, on the curve rather than on a
          // straight line the curve has left.
          const midX = (x1 + 3 * c1 + 3 * c2 + x2) / 8;
          const midY = (y1 + 3 * y1 + 3 * y2 + y2) / 8;
          const hot = edge.traces >= maxTraces && edges.length > 1;
          return (
            <g key={`${edge.from}->${edge.to}`}>
              <path
                d={path}
                fill="none"
                stroke={hot ? colors.accentText : colors.borderStrong}
                strokeWidth={1 + (edge.traces / maxTraces) * 1.8}
                markerEnd={hot ? "url(#map-arrow-hot)" : "url(#map-arrow)"}
                opacity={0.9}
              >
                <title>
                  {`${edge.fromName} → ${edge.toName}: ${formatNumber(edge.traces)} ${
                    edge.traces === 1 ? "trace" : "traces"
                  }`}
                </title>
              </path>
              <text
                x={midX}
                y={midY - 5}
                textAnchor="middle"
                fontSize={9.5}
                fill={hot ? colors.accentText : colors.muted}
                stroke={colors.surface}
                strokeWidth={3}
                paintOrder="stroke"
                style={{ pointerEvents: "none" }}
              >
                {`${formatCount(edge.traces)} ${edge.traces === 1 ? "trace" : "traces"}`}
              </text>
            </g>
          );
        })}

        {Object.values(placed).map(({ node, x, y }) => {
          const active = node.id === scope;
          const href = `/applications/${node.id}`;
          return (
            <g
              key={node.id}
              tabIndex={0}
              role="link"
              aria-label={`${node.name}: ${node.requests} ${node.requests === 1 ? "request" : "requests"}, ${node.jobs} ${node.jobs === 1 ? "job" : "jobs"}, ${node.errors} errors`}
              onClick={() => go(`${href}?range=${range}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter") go(`${href}?range=${range}`);
              }}
              style={{ cursor: "pointer" }}
            >
              <title>
                {node.outsideScope
                  ? `${node.name} — outside the current application scope`
                  : `${node.name}: ${formatNumber(node.requests)} requests · ${formatNumber(
                      node.jobs,
                    )} jobs · ${formatNumber(node.errors)} errors`}
              </title>
              <rect
                x={x}
                y={y}
                width={nodeW}
                height={nodeH}
                rx={9}
                fill={colors.surfaceRaised}
                stroke={active ? colors.accent : colors.borderStrong}
                strokeWidth={active ? 1.25 : 1}
              />
              <text x={x + 12} y={y + 19} fontSize={12} fontWeight={600} fill={colors.text}>
                {truncate(node.name, 22)}
              </text>
              {node.outsideScope ? (
                <text x={x + 12} y={y + 37} fontSize={10} fill={colors.faint}>
                  outside this scope
                </text>
              ) : (
                <text x={x + 12} y={y + 37} fontSize={10} fill={colors.muted}>
                  {`${formatCount(node.requests)} ${node.requests === 1 ? "request" : "requests"} · ${formatCount(node.jobs)} ${node.jobs === 1 ? "job" : "jobs"}`}
                </text>
              )}
              {!node.outsideScope && (
                <text
                  x={x + 12}
                  y={y + 53}
                  fontSize={10}
                  fill={node.errors > 0 ? colors.danger : colors.faint}
                >
                  {node.errors > 0
                    ? `${formatCount(node.errors)} errors`
                    : "no errors"}
                </text>
              )}
            </g>
          );
        })}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Layout: deterministic, left to right
// ---------------------------------------------------------------------------

function layoutGraph(
  nodes: GraphNode[],
  edges: ServiceMapEdge[],
): { layers: GraphNode[][] } {
  if (nodes.length === 0) return { layers: [] };
  const ids = new Set(nodes.map((node) => node.id));
  const links = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);

  // Depth-first walk, marking back edges. Two applications can appear in traces
  // in both orders, so the raw edge set can contain a cycle; layering a cycle is
  // impossible and an unbroken one would push both ends to infinity. Back edges
  // are excluded from the *layer* maths only — they are still drawn.
  const outgoing: Record<string, string[]> = {};
  for (const edge of links) {
    (outgoing[edge.from] ??= []).push(edge.to);
  }
  for (const id of Object.keys(outgoing)) {
    outgoing[id]?.sort();
  }
  const state: Record<string, 1 | 2> = {};
  const backEdges = new Set<string>();
  const visit = (id: string): void => {
    state[id] = 1;
    for (const next of outgoing[id] ?? []) {
      if (state[next] === 1) backEdges.add(`${id}->${next}`);
      else if (!state[next]) visit(next);
    }
    state[id] = 2;
  };
  for (const node of nodes) if (!state[node.id]) visit(node.id);

  const forward = links.filter((edge) => !backEdges.has(`${edge.from}->${edge.to}`));

  // Longest path from a root, by Kahn's algorithm: a node's column is one past
  // its deepest caller, so a chain gateway → api → worker reads left to right.
  const indegree: Record<string, number> = {};
  for (const node of nodes) indegree[node.id] = 0;
  for (const edge of forward) indegree[edge.to] = (indegree[edge.to] ?? 0) + 1;
  const layer: Record<string, number> = {};
  for (const node of nodes) layer[node.id] = 0;

  const queue = nodes.filter((node) => (indegree[node.id] ?? 0) === 0).map((node) => node.id);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    visited.add(id);
    for (const edge of forward) {
      if (edge.from !== id) continue;
      layer[edge.to] = Math.max(layer[edge.to] ?? 0, (layer[id] ?? 0) + 1);
      indegree[edge.to] = (indegree[edge.to] ?? 1) - 1;
      if (indegree[edge.to] === 0) queue.push(edge.to);
    }
  }
  // A node the walk never reached can only be in an unresolved cycle; it keeps
  // layer 0 and stands with the roots rather than disappearing.
  for (const node of nodes) if (!visited.has(node.id)) layer[node.id] = 0;

  const layerCount = Math.max(0, ...nodes.map((node) => layer[node.id] ?? 0)) + 1;
  const layers: GraphNode[][] = Array.from({ length: layerCount }, () => []);
  for (const node of nodes) {
    const column = layers[layer[node.id] ?? 0];
    if (column) column.push(node);
  }
  for (const column of layers) {
    // Busiest first, then alphabetical: stable across polls, which matters more
    // than any clever heuristic at this size.
    column.sort(
      (a, b) => b.requests + b.jobs - (a.requests + a.jobs) || a.name.localeCompare(b.name),
    );
  }
  return { layers };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ---------------------------------------------------------------------------
// The edge table: the drawing's numbers, in a form that does not depend on width
// ---------------------------------------------------------------------------

function EdgeTable({ edges, go }: { edges: ServiceMapEdge[]; go: (to: string) => void }) {
  const maxTraces = Math.max(1, ...edges.map((edge) => edge.traces));
  return (
    <Paper sx={{ overflow: "hidden" }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>From</TableCell>
            <TableCell>To</TableCell>
            <TableCell align="right">Traces</TableCell>
            <TableCell sx={{ width: 160 }}>Share of the busiest link</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {edges.map((edge) => (
            <TableRow key={`${edge.from}->${edge.to}`}>
              <TableCell>
                <Box
                  component="button"
                  type="button"
                  onClick={() => go(`/applications/${edge.from}`)}
                  sx={applicationButton}
                >
                  {edge.fromName}
                </Box>
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                  <Typography sx={{ fontSize: 11, color: "text.disabled" }}>→</Typography>
                  <Box
                    component="button"
                    type="button"
                    onClick={() => go(`/applications/${edge.to}`)}
                    sx={applicationButton}
                  >
                    {edge.toName}
                  </Box>
                </Stack>
              </TableCell>
              <TableCell align="right" sx={tabular}>
                {formatNumber(edge.traces)}
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <Box
                    sx={{
                      flex: 1,
                      height: 4,
                      borderRadius: 1,
                      bgcolor: "rgba(255,255,255,0.07)",
                      overflow: "hidden",
                    }}
                  >
                    <Box
                      sx={{
                        width: `${(edge.traces / maxTraces) * 100}%`,
                        height: "100%",
                        backgroundColor: colors.accent,
                      }}
                    />
                  </Box>
                </Stack>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography
        sx={{
          px: 2,
          py: 1.25,
          borderTop: `1px solid ${colors.border}`,
          fontSize: 11,
          color: "text.disabled",
          lineHeight: 1.6,
        }}
      >
        An edge counts traces that carried both applications, in the order shown — one trace is
        one count, however many spans it had. Jobs are counted separately from requests on the
        nodes: a queue consumer inheriting the producer&apos;s trace id is a real hop, but its
        runs are not request traffic.
      </Typography>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

const applicationButton = {
  p: 0,
  border: 0,
  background: "none",
  font: "inherit",
  fontFamily: fontMono,
  fontSize: 11.5,
  color: "text.primary",
  cursor: "pointer",
  borderBottom: `1px dotted ${colors.borderStrong}`,
} as const;

function LegendItem({ label }: { label: string }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
      <Box
        sx={{
          width: 10,
          height: 10,
          borderRadius: "2px",
          border: `1px solid ${colors.borderStrong}`,
          backgroundColor: colors.surfaceRaised,
        }}
      />
      <Typography sx={{ ...labelCaps, color: "text.secondary" }}>{label}</Typography>
    </Stack>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box
      sx={{
        border: `1px solid ${colors.border}`,
        borderRadius: 1,
        px: 1.5,
        py: 0.75,
        minWidth: 74,
      }}
    >
      <Typography sx={labelCaps}>{label}</Typography>
      <Typography sx={{ ...tabular, fontSize: 16, fontWeight: 600 }}>{value}</Typography>
    </Box>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <Box
      sx={{
        px: 3,
        py: 6,
        textAlign: "center",
        border: `1px dashed ${colors.borderStrong}`,
        borderRadius: 1,
      }}
    >
      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{title}</Typography>
      <Typography
        sx={{ mt: 0.75, fontSize: 11.5, color: "text.disabled", maxWidth: 560, mx: "auto" }}
      >
        {hint}
      </Typography>
    </Box>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
