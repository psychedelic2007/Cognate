/**
 * A starting vocabulary of research topics at the grain that makes a graph work.
 *
 * Without this, the first lab defines the vocabulary from nothing and the model
 * reaches for whatever phrasing the source text used — "tim barrel scaffold",
 * "light-powered molecular motors", "superantigen-inspired immunotherapy".
 * Those are project titles. No second lab will ever produce the same string, so
 * no two labs can share a topic, so the graph has no edges. Observed in the
 * wild: three labs, nineteen labels, zero overlap.
 *
 * The right grain is a subject heading a programme committee would use — broad
 * enough that two labs in the same field land on it, narrow enough to
 * distinguish fields. Everything more specific belongs in a topic's `detail`.
 *
 * This list is offered to the model as preferred labels, not imposed. It skews
 * toward computational and molecular bioscience because that is where the tool
 * was built; add your own for other fields.
 */
export interface StarterPack {
  id: string;
  name: string;
  blurb: string;
  vocabulary: string[];
}

/**
 * One built-in pack, not one per field.
 *
 * Hand-writing a vocabulary for chemistry, then materials, then economics does
 * not scale and none of them could be tested. Everything outside life sciences
 * is generated from the person's own keywords at first run, which also handles
 * the purely experimental corners of biology this list under-serves.
 */
export const LIFE_SCIENCES: string[] = [
  // protein science and design
  "protein design", "protein structure prediction", "protein folding",
  "protein language models", "directed evolution", "enzyme engineering",
  "protein interactions", "protein dynamics", "intrinsically disordered proteins",
  "protein stability", "peptide design", "antibody engineering",
  "de novo design", "inverse folding", "protein aggregation",
  "post translational modification", "allostery", "molecular chaperones",

  // structural and biophysical methods
  "cryo em", "x ray crystallography", "nmr spectroscopy", "mass spectrometry",
  "molecular dynamics", "single molecule biophysics", "structural biology",
  "coarse grained simulation", "free energy calculation", "docking",

  // machine learning and computation
  "deep learning", "generative models", "diffusion models", "graph neural networks",
  "transformers", "representation learning", "bayesian inference",
  "reinforcement learning", "active learning", "interpretable machine learning",
  "foundation models", "uncertainty quantification",

  // genomics and sequence analysis
  "genome assembly", "variant effect prediction", "genome editing",
  "single cell genomics", "transcriptomics", "epigenomics", "gwas",
  "population genetics", "phylogenetics", "comparative genomics",
  "sequence function relationships", "deep mutational scanning",
  "coevolution analysis", "long read sequencing",
  // "spatial transcriptomics" is deliberately absent: containment folds it into
  // "transcriptomics", which is the intended behaviour. The speciality belongs
  // in a topic's `detail`, not in a second label the graph cannot distinguish.

  // evolution
  "viral evolution", "molecular evolution", "fitness landscapes", "epistasis",
  "experimental evolution", "microbial evolution", "phylodynamics",
  "antimicrobial resistance", "host pathogen coevolution", "cancer evolution",

  // virology and infectious disease
  "virology", "antibody escape", "vaccine design", "viral entry",
  "influenza", "sars cov 2", "hiv", "epidemiology", "outbreak surveillance",
  "antiviral discovery",

  // immunology
  "immunology", "t cell receptors", "b cell repertoires", "epitope prediction",
  "immune repertoire sequencing", "autoimmunity", "tumour immunology",
  "innate immunity", "immunotherapy",

  // neuroscience
  "neurodegeneration", "alzheimers disease", "amyloid beta", "tau pathology",
  "glymphatic clearance", "blood brain barrier", "neuroimaging",
  "sleep and clearance", "synaptic function", "neural circuits",
  "computational neuroscience",

  // systems, mathematical and quantitative biology
  "systems biology", "compartmental modelling", "dynamical systems",
  "stochastic modelling", "pharmacokinetics", "network biology",
  "metabolic modelling", "gene regulatory networks", "biological physics",
  "information theory in biology", "parameter inference",

  // cell and molecular biology
  "cell biology", "gene regulation", "rna biology", "crispr screens",
  "synthetic biology", "membrane biology", "organelle biology",
  "developmental biology", "stem cells", "microscopy",

  // chemistry, drug discovery, translation
  "drug discovery", "small molecule design", "medicinal chemistry",
  "chemical biology", "target identification", "admet prediction",
  "clinical trials", "biomarkers", "precision medicine", "nucleic acid therapeutics",
  "aptamer design", "delivery systems",

  // microbiology and ecology
  "microbiome", "metagenomics", "bacterial genetics", "biofilms",
  "microbial ecology", "plant biology", "ecology and evolution",
];

export const STARTER_PACKS: StarterPack[] = [
  {
    id: "life-sciences",
    name: "Life sciences & biomedicine",
    blurb: "Molecular and computational bioscience, structural biology, genomics, immunology, neuroscience.",
    vocabulary: LIFE_SCIENCES,
  },
];

/** Back-compatible alias. The default when no field has been configured. */
export const SEED_VOCAB = LIFE_SCIENCES;

export const packById = (id: string): StarterPack | undefined =>
  STARTER_PACKS.find((p) => p.id === id);
