export type Modality =
  | 'DOCUMENT'
  | 'INVOICE'
  | 'EMAIL'
  | 'AUDIO'
  | 'IMAGE'
  | 'CCTV'
  | 'DRONE'
  | 'ARCHIVE'
  | 'UNKNOWN';

export type ItemStatus =
  | 'IMPORTED'
  | 'QUEUED'
  | 'PREPROCESSING'
  | 'PROCESSING'
  | 'STRUCTURING'
  | 'COMPILED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type ExportFormat = 'XLSX' | 'CSV' | 'PDF' | 'JSON' | 'GEOJSON' | 'TXT' | 'DOCX';

export interface User {
  id: string;
  email: string;
  name: string;
  provider: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
}

export interface FileRecord {
  id: string;
  reference: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number | string;
  modality: Modality;
  scanStatus: string;
  duplicateOfId: string | null;
  archiveId?: string | null;
  archivePath?: string | null;
  archive?: { id: string; reference: string; originalName: string } | null;
  createdAt: string;
}

export interface ImportRecord {
  id: string;
  reference: string;
  source: string;
  label: string | null;
  createdAt: string;
  _count?: { files: number };
}

export interface ProcessingJob {
  id: string;
  reference: string;
  name: string;
  status: ItemStatus;
  totalItems: number;
  doneItems: number;
  failedItems: number;
  createdAt: string;
}

export interface Measurement {
  subject: string;
  parameter: string;
  value: number | null;
  unit: string | null;
  status: 'MEASURED' | 'ESTIMATED' | 'UNAVAILABLE';
  method: string | null;
  source: string | null;
  quality: string | null;
  confidence: number | null;
  reason: string | null;
}

export interface ProcessingResult {
  id: string;
  engine: string;
  engineVersion: string;
  demo: boolean;
  data: Record<string, unknown>;
  measurements: Measurement[];
  warnings: string[];
  confidence: number | null;
  version: number;
}

export interface ProcessingItem {
  id: string;
  position: number;
  status: ItemStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  attempts: number;
  file: FileRecord;
}

export interface Correction {
  id: string;
  field: string;
  modality: Modality;
  originalValue: unknown;
  correctedValue: unknown;
  note: string | null;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  createdAt: string;
}

export interface Compilation {
  id: string;
  name: string;
  modality: Modality;
  columns: string[];
  recordCount: number;
  updatedAt: string;
}

export interface CompilationRecord {
  id: string;
  rowKey: string;
  data: Record<string, unknown>;
  geometry: unknown;
  removed: boolean;
}

export interface ExportJob {
  id: string;
  reference: string;
  format: ExportFormat;
  status: string;
  rowCount: number | null;
  sizeBytes: number | string | null;
  error: string | null;
  createdAt: string;
  compilation?: { name: string; modality: Modality };
}
