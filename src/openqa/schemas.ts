export type EntityKind =
  | "Gene" | "Protein" | "Pathway" | "Variant" | "Disease" | "Drug" | "Trial" | "Publication";

export type Xref = Record<string, string | string[]>;

export interface BaseRecord {
  kind: EntityKind;
  id?: string;
  label?: string;
  xref?: Xref;
  source?: { server: string; tool: string; args?: Record<string, any> };
  meta?: Record<string, any>;
  date?: string;
}

export interface GeneRecord extends BaseRecord { kind: "Gene"; symbol?: string; organism?: string; }
export interface ProteinRecord extends BaseRecord { kind: "Protein"; accession?: string; geneSymbol?: string; }
export interface PathwayRecord extends BaseRecord { kind: "Pathway"; pathwayId?: string; }
export interface VariantRecord extends BaseRecord { kind: "Variant"; hgvs?: string; geneSymbol?: string; }
export interface DiseaseRecord extends BaseRecord { kind: "Disease"; diseaseName?: string; }
export interface DrugRecord extends BaseRecord { kind: "Drug"; synonyms?: string[]; }
export interface TrialRecord extends BaseRecord {
  kind: "Trial"; nctId?: string; title?: string; status?: string; phase?: string; condition?: string; interventions?: string[];
}
export interface PublicationRecord extends BaseRecord { kind: "Publication"; pmid?: string; doi?: string; title?: string; }

export type CanonicalRecord =
  | GeneRecord | ProteinRecord | PathwayRecord | VariantRecord | DiseaseRecord | DrugRecord | TrialRecord | PublicationRecord;

export interface Slots {
  genes: string[];
  variants: string[];
  diseases: string[];
  drugs: string[];
  phases: number[];
  nctIds: string[];
  organism?: string;
}

export interface AnswerCard {
  query: string;
  slots: Slots;
  entities: {
    genes: GeneRecord[]; proteins: ProteinRecord[]; pathways: PathwayRecord[]; variants: VariantRecord[];
    diseases: DiseaseRecord[]; drugs: DrugRecord[]; trials: TrialRecord[]; publications: PublicationRecord[];
  };
  highlights: Array<{ text: string; recordId?: string }>;
  evidence: Array<{ recordKind: EntityKind; label?: string; id?: string; source: { server: string; tool: string } }>;
  toolsRun: Array<{ server: string; tool: string; ok: boolean; ms: number }>;
  notes?: string;
}
