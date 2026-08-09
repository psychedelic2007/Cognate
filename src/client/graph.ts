import { select, type Selection } from "d3-selection";
import { drag } from "d3-drag";
import { zoom } from "d3-zoom";
import { arc } from "d3-shape";
import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation,
  type Simulation, type SimulationNodeDatum,
} from "d3-force";
import type { Fit, Lab, Profile, Topic } from "../core/types.js";

export const CH: Record<string, string> = {
  system: "#3ED598", method: "#4C8DFF", theory: "#C77DFF", application: "#FF8A4C",
};
export const YOU = "#FFD166";
export const chColor = (c: string) => CH[c] ?? CH.method;

export type NodeDatum = SimulationNodeDatum & {
  id: string;
  kind: "lab" | "topic" | "me" | "pending";
  r: number;
  lab?: Lab;
  fit?: Fit | null;
  topic?: Topic;
  parent?: string;
  label?: string;
};
export type LinkDatum = {
  source: string | NodeDatum;
  target: string | NodeDatum;
  kind: "peer" | "child" | "me";
  sim: number;
  shared?: { label: string; wa: number; wb: number }[];
  fit?: Fit;
};

export interface GraphCallbacks {
  onLabClick(lab: Lab): void;
  onMeClick(): void;
  onTopicClick(label: string): void;
  onHover(html: string | null, ev?: MouseEvent): void;
}

const idOf = (x: string | NodeDatum) => (typeof x === "object" ? x.id : x);

export class Graph {
  private root: Selection<SVGGElement, unknown, null, undefined>;
  private gLink: Selection<SVGGElement, unknown, null, undefined>;
  private gNode: Selection<SVGGElement, unknown, null, undefined>;
  private sim: Simulation<NodeDatum, undefined> | null = null;
  private svg: Selection<SVGSVGElement, unknown, null, undefined>;

  constructor(svgEl: SVGSVGElement, private cb: GraphCallbacks) {
    this.svg = select(svgEl);
    this.root = this.svg.append("g");
    this.gLink = this.root.append("g");
    this.gNode = this.root.append("g");
    this.svg.call(
      zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.2, 3])
        .on("zoom", (ev) => this.root.attr("transform", ev.transform.toString())),
    );
  }

  render(
    nodes: NodeDatum[], links: LinkDatum[],
    opts: { width: number; height: number; spread: number; selected: string | null; expanded: Set<string>; me: Profile | null },
  ): void {
    // Carry positions forward so adding one lab does not scramble the map.
    const prev = new Map((this.sim?.nodes() ?? []).map((n) => [n.id, n]));
    for (const n of nodes) {
      const o = prev.get(n.id);
      if (o) { n.x = o.x; n.y = o.y; n.vx = o.vx; n.vy = o.vy; }
    }

    const lsel = this.gLink.selectAll<SVGLineElement, LinkDatum>("line")
      .data(links, (d) => `${idOf(d.source)}|${idOf(d.target)}`);
    lsel.exit().remove();
    lsel.enter().append("line").merge(lsel)
      .attr("class", (d) => (d.kind === "child" ? "link child" : d.kind === "me" ? "link me" : "link"))
      .attr("stroke-width", (d) => (d.kind === "child" ? 1 : 1 + d.sim * 11))
      .attr("stroke-opacity", (d) => (d.kind === "child" ? 0.45 : 0.3 + d.sim * 0.55))
      .attr("stroke-dasharray", (d) => (d.kind === "me" ? "5 4" : null))
      .on("mousemove", (ev: MouseEvent, d) => {
        if (d.kind === "peer") this.cb.onHover(this.edgeTip(d, nodes), ev);
        else if (d.kind === "me" && d.fit) this.cb.onHover(this.meTip(d), ev);
      })
      .on("mouseleave", () => this.cb.onHover(null));

    const nsel = this.gNode.selectAll<SVGGElement, NodeDatum>("g.node").data(nodes, (d) => d.id);
    nsel.exit().remove();
    const enter = nsel.enter().append("g").attr("class", "node");
    enter.filter((d) => d.kind === "lab" || d.kind === "pending").each(function () {
      const g = select(this);
      g.append("g").attr("class", "ring");
      g.append("circle").attr("class", "core");
      g.append("text").attr("class", "node-label");
      g.append("text").attr("class", "fit-label");
    });
    enter.filter((d) => d.kind === "me").each(function () {
      const g = select(this);
      g.append("path").attr("class", "mecore");
      g.append("text").attr("class", "node-label");
    });
    enter.filter((d) => d.kind === "topic").each(function () {
      const g = select(this);
      g.append("circle").attr("class", "tdot");
      g.append("text").attr("class", "topic-label");
    });
    const all = enter.merge(nsel);

    const ringArc = arc<{ startAngle: number; endAngle: number }>();
    all.filter((d) => d.kind === "lab").each(function (d) {
      const g = select(this);
      const lab = d.lab!;
      g.select("circle.core").attr("r", d.r).attr("fill", "#1A2437")
        .attr("stroke", opts.selected === d.id ? "#E4E9F2" : "#3A4661")
        .attr("stroke-width", opts.selected === d.id ? 2 : 1.2);
      const total = lab.topics.reduce((s, t) => s + t.weight, 0) || 1;
      let acc = 0;
      const segs = lab.topics.map((t) => {
        const a0 = (acc / total) * 2 * Math.PI;
        acc += t.weight;
        return {
          d: ringArc({ startAngle: a0, endAngle: (acc / total) * 2 * Math.PI, innerRadius: d.r + 3.5, outerRadius: d.r + 8.5, padAngle: 0.035 } as never) ?? "",
          c: chColor(t.category),
        };
      });
      const paths = g.select("g.ring").selectAll<SVGPathElement, { d: string; c: string }>("path").data(segs);
      paths.exit().remove();
      paths.enter().append("path").merge(paths)
        .attr("d", (s) => s.d).attr("fill", (s) => s.c)
        .attr("opacity", opts.expanded.has(d.id) ? 0.95 : 0.78);
      g.select("text.node-label").attr("y", d.r + 26).attr("font-size", 13).text(lab.name);
      g.select("text.fit-label").attr("y", d.r + 40).text(d.fit ? `fit ${d.fit.score.toFixed(0)}` : "");
    });

    all.filter((d) => d.kind === "pending").each(function (d) {
      const g = select(this);
      g.select("circle.core").attr("r", d.r).attr("fill", "#1A2437")
        .attr("stroke", "#3A4661").attr("stroke-width", 1.2).attr("stroke-dasharray", "4 4");
      g.select("g.ring").selectAll("path").remove();
      g.select("text.node-label").attr("y", d.r + 26).attr("font-size", 13)
        .attr("fill", "#5B687F").text(d.label ?? "");
      g.select("text.fit-label").attr("y", d.r + 40).attr("fill", "#5B687F").text("reading…");
    });

    all.filter((d) => d.kind === "me").each(function (d) {
      const g = select(this), R = d.r;
      g.select("path.mecore")
        .attr("d", `M0,${-R} L${R},0 L0,${R} L${-R},0 Z`)
        .attr("fill", "#241E08").attr("stroke", YOU).attr("stroke-width", 2);
      g.select("text.node-label").attr("y", R + 22).attr("font-size", 13)
        .attr("fill", YOU).text(opts.me?.name || "You");
    });

    all.filter((d) => d.kind === "topic").each(function (d) {
      const g = select(this), c = chColor(d.topic!.category);
      g.select("circle.tdot").attr("r", d.r).attr("fill", c)
        .attr("opacity", 0.3 + d.topic!.weight * 0.6).attr("stroke", c).attr("stroke-width", 1);
      g.select("text.topic-label").attr("y", d.r + 13).attr("fill", c).text(d.topic!.label);
    });

    all
      .on("click", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        if (d.kind === "lab") this.cb.onLabClick(d.lab!);
        else if (d.kind === "me") this.cb.onMeClick();
        else if (d.kind === "topic") this.cb.onTopicClick(d.topic!.label);
      })
      .on("mousemove", (ev: MouseEvent, d) => {
        if (d.kind === "topic") this.cb.onHover(this.topicTip(d, nodes, opts.me), ev);
      })
      .on("mouseleave", () => this.cb.onHover(null))
      .call(
        drag<SVGGElement, NodeDatum>()
          .on("start", (ev, d) => { if (!ev.active) this.sim?.alphaTarget(0.28).restart(); d.fx = d.x; d.fy = d.y; })
          .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
          .on("end", (ev, d) => { if (!ev.active) this.sim?.alphaTarget(0); d.fx = null; d.fy = null; }),
      );

    this.sim?.stop();
    // Link distance falls and strength rises with similarity, so the closest
    // match physically sits nearest.
    this.sim = forceSimulation<NodeDatum>(nodes)
      .force("link", forceLink<NodeDatum, LinkDatum>(links).id((d) => d.id)
        .distance((d) => (d.kind === "child" ? 58 + (1 - d.sim) * 26 : (95 + (1 - d.sim) * 300) * opts.spread))
        .strength((d) => (d.kind === "child" ? 0.85 : Math.min(1, 0.06 + d.sim * 1.15))))
      .force("charge", forceManyBody<NodeDatum>().strength((d) => (d.kind === "topic" ? -140 : -1000 * opts.spread)))
      .force("center", forceCenter(opts.width / 2, opts.height / 2))
      .force("collide", forceCollide<NodeDatum>().radius((d) => (d.kind === "topic" ? d.r + 22 : d.r + 42)))
      .alpha(0.9)
      .restart();

    this.sim.on("tick", () => {
      this.gLink.selectAll<SVGLineElement, LinkDatum>("line")
        .attr("x1", (d) => (d.source as NodeDatum).x ?? 0).attr("y1", (d) => (d.source as NodeDatum).y ?? 0)
        .attr("x2", (d) => (d.target as NodeDatum).x ?? 0).attr("y2", (d) => (d.target as NodeDatum).y ?? 0);
      this.gNode.selectAll<SVGGElement, NodeDatum>("g.node")
        .attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });
  }

  highlight(label: string, labs: Lab[], me: Profile | null): void {
    const hits = new Set(labs.filter((l) => l.topics.some((t) => t.label === label)).map((l) => l.id));
    const mine = Boolean(me?.topics.some((t) => t.label === label));
    this.gNode.selectAll<SVGGElement, NodeDatum>("g.node").classed("dim", (d) =>
      d.kind === "topic" ? d.topic!.label !== label : d.kind === "me" ? !mine : !hits.has(d.id));
    this.gLink.selectAll("line").classed("dim", true);
    setTimeout(() => {
      this.gNode.selectAll("g.node").classed("dim", false);
      this.gLink.selectAll("line").classed("dim", false);
    }, 2600);
  }

  private esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  private edgeTip(d: LinkDatum, nodes: NodeDatum[]): string {
    const a = nodes.find((n) => n.id === idOf(d.source))?.lab;
    const b = nodes.find((n) => n.id === idOf(d.target))?.lab;
    if (!a || !b) return "";
    return `<div class="t-h">${this.esc(a.name)} ⟷ ${this.esc(b.name)}</div>
<div class="t-r" style="color:var(--ch-system);margin-bottom:6px"><span>similarity</span><span>${d.sim.toFixed(3)}</span></div>
${(d.shared ?? []).slice(0, 6).map((s) => `<div class="t-r"><span>${this.esc(s.label)}</span><span>${s.wa.toFixed(2)} × ${s.wb.toFixed(2)}</span></div>`).join("")}`;
  }

  private meTip(d: LinkDatum): string {
    const f = d.fit!;
    return `<div class="t-h" style="color:${YOU}">You ⟷ this lab</div>
<div class="t-r"><span>fit index</span><span style="color:${YOU}">${f.score.toFixed(0)}</span></div>
<div class="t-r"><span>foundation</span><span>${f.foundation.toFixed(3)}</span></div>
<div class="t-r"><span>leverage</span><span>${f.leverage.toFixed(3)}</span></div>
<div class="t-r"><span>growth</span><span>${f.growth.toFixed(3)}</span></div>`;
  }

  private topicTip(d: NodeDatum, nodes: NodeDatum[], me: Profile | null): string {
    const t = d.topic!;
    const also = nodes.filter((n) => n.kind === "lab" && n.id !== d.parent && n.lab!.topics.some((x) => x.label === t.label));
    const mine = me?.topics.find((x) => x.label === t.label);
    return `<div class="t-h" style="color:${chColor(t.category)}">${this.esc(t.label)}</div>
<div class="t-r"><span>${t.category}${t.recency && t.recency !== "core" ? " · " + t.recency : ""}</span><span>weight ${t.weight.toFixed(2)}</span></div>
${t.detail ? `<div style="margin-top:5px;font-size:11.5px">${this.esc(t.detail)}</div>` : ""}
${t.evidence ? `<div style="margin-top:6px;color:var(--ink-mute);font-size:11.5px;font-style:italic">${this.esc(t.evidence)}</div>` : ""}
${also.length ? `<div style="margin-top:6px;font-size:11.5px;color:var(--ch-system)">Also in: ${also.map((n) => this.esc(n.lab!.name)).join(", ")}</div>` : ""}
${mine ? `<div style="margin-top:4px;font-size:11.5px;color:${YOU}">You: ${mine.weight.toFixed(2)}</div>` : ""}`;
  }
}
