export type Category = "system" | "method" | "theory" | "application";
export type Recency = "emerging" | "core" | "legacy";

export interface Topic {
  label: string;
  category: Category;
  /** For a lab: centrality to its programme. For a person: demonstrated depth. */
  weight: number;
  /**
   * For a person only: how much they want to keep doing this. 1 = central to
   * where they are going, 0 = finished with it.
   *
   * Credibility and appetite are different things. A side project from four
   * years ago still makes you credible in that area, so it must not vanish —
   * but it should stop dragging the ranking toward labs you have moved on
   * from. Undefined means 1, so older profiles keep working.
   */
  pursuit?: number;
  /**
   * The lab's own specific phrasing, kept out of the maths.
   *
   * "deep learning protein design" is a project description, not a topic. Put
   * the grain the graph needs in `label` and the specificity here, or no two
   * labs will ever share a topic and the map will have no edges.
   */
  detail?: string;
  evidence?: string;
  /** Where this sits in the lab's trajectory. Inferred, and the least reliable field here. */
  recency?: Recency;
}

/** Anything with a topic vector: a lab or a person. */
export interface Entity {
  topics: Topic[];
}

export interface Lab extends Entity {
  id: string;
  name: string;
  institution: string;
  summary: string;
  sources: { name: string; chars: number }[];
  addedAt: string;
}

export interface Asset {
  kind: string;
  text: string;
}

export interface Profile extends Entity {
  name: string;
  stage: string;
  headline: string;
  assets: Asset[];
  source: string;
  /**
   * What they want to do next, which is not the same thing as what they have
   * done. Weight is strength of intent. Empty when they never said.
   */
  aspiration: Topic[];
  aspirationNote: string;
}

/** What the person works on, set once and used to build the topic vocabulary. */
export interface FieldConfig {
  /** Free text: "experimental structural biology", "condensed matter physics". */
  description: string;
  keywords: string[];
  /** Canonical subject headings for this field. Generated, or a built-in pack. */
  vocabulary: string[];
  /** Which starter pack was used, if any. */
  pack?: string;
  createdAt: string;
}

export interface State {
  labs: Lab[];
  vocab: string[];
  me: Profile | null;
  field: FieldConfig | null;
}

/** The portable save file. Everything needed to restore a session. */
export interface SaveFile {
  format: "landscape";
  version: 1;
  savedAt: string;
  state: State;
  settings?: {
    threshold?: number; spread?: number; lambda?: number;
    portfolioK?: number; weights?: Record<string, number>;
  };
}

export interface Shared {
  label: string;
  wa: number;
  wb: number;
}

export interface Similarity {
  sim: number;
  shared: Shared[];
}

export interface Edge extends Similarity {
  a: string;
  b: string;
}

/** Per-lab structural properties, computed from the network rather than the lab alone. */
export interface LabMetrics {
  id: string;
  /** 0 = spread evenly across topics, 1 = one topic dominates. */
  focus: number;
  /** Degree centrality within the lab graph. Central = mainstream for your interests. */
  centrality: number;
  /** Weight in emerging topics minus weight in legacy ones. Null when no tags present. */
  momentum: number | null;
  /** Connected-component index at the current threshold. */
  cluster: number;
}

export type RiskFlag =
  | "thin-foundation"
  | "redundant"
  | "nothing-to-learn"
  | "isolated"
  | "declining"
  /** Plenty to learn here, but not in the direction they said they want. */
  | "off-direction"
  /** A pivot with no portable method to carry across. */
  | "no-bridge"
  /** The overlap is mostly work the person has moved on from. */
  | "past-self";

/**
 * A move into a new field works when you carry a technique with you. Your
 * methods and frameworks are portable; their systems and applications are
 * where you would apply them.
 */
export interface Transfer {
  /** Your method/theory topics this lab does not already have. */
  portable: { label: string; weight: number }[];
  /** Their system/application topics you have not worked in. */
  targets: { label: string; weight: number }[];
  /** Geometric mean: a pivot needs both a technique and somewhere to put it. */
  score: number;
}

export interface Fit {
  labId: string;
  foundation: number;
  leverage: number;
  leverageRaw: number;
  gate: number;
  growth: number;
  /** Share of the lab's work lying where they said they are heading. Null when unstated. */
  direction: number | null;
  transfer: Transfer;
  score: number;
  shared: Shared[];
  /** Your scarce topics this lab lacks — why they would hire you. */
  missing: { label: string; weight: number; idf: number; df: number }[];
  /** Their topics you lack — what you would gain. */
  learn: { label: string; weight: number }[];
  /** Shared ground that comes from work the person has moved on from. */
  retiredOverlap: { label: string; weight: number; pursuit: number }[];
  risks: RiskFlag[];
}

export interface AssetRow {
  label: string;
  category: Category;
  weight: number;
  df: number;
  idf: number;
  value: number;
}

export interface PortfolioPick {
  labId: string;
  fit: Fit;
  /** Marginal contribution once the labs above it are already chosen. */
  marginal: number;
  /** Topics this lab covers that no earlier pick does. */
  uniqueCoverage: string[];
}


/** A candidate PI found through OpenAlex rather than typed in by hand. */
export interface Candidate {
  authorId: string;
  name: string;
  institution: string;
  worksCount: number;
  citedByCount: number;
  /** How many of the searched topics this person appears under. */
  topicHits: string[];
  recentTitles: string[];
  orcid?: string;
}
