import type { CriteriaGroup, ImportDTO, ImportOptionsDTO, ImportPreviewDTO, ImportReportDTO, ImportTarget, SegmentDTO, SegmentPreviewDTO } from '@morrow/core';
import type { Transport } from '../http';
import type { Items, Ok } from '../types';

export class SegmentsApi {
  constructor(private readonly t: Transport) {}

  list(): Promise<Items<SegmentDTO>> {
    return this.t.json('GET', '/segments');
  }
  get(id: string): Promise<SegmentDTO> {
    return this.t.json('GET', `/segments/${id}`);
  }
  create(input: { name: string; description?: string | null; criteria: CriteriaGroup }): Promise<SegmentDTO> {
    return this.t.json('POST', '/segments', { body: input });
  }
  update(id: string, input: { name?: string; description?: string | null; criteria?: CriteriaGroup }): Promise<SegmentDTO> {
    return this.t.json('PATCH', `/segments/${id}`, { body: input });
  }
  /** Count and sample matching contacts without saving. */
  preview(criteria: CriteriaGroup, limit?: number): Promise<SegmentPreviewDTO> {
    return this.t.json('POST', '/segments/preview', { body: { criteria, limit } });
  }
  refresh(id: string): Promise<SegmentDTO> {
    return this.t.json('POST', `/segments/${id}/refresh`);
  }
  archive(id: string): Promise<Ok> {
    return this.t.json('DELETE', `/segments/${id}`);
  }
}

export interface ImportPlan {
  /** One target per CSV column, in column order. */
  mapping: ImportTarget[];
  options?: Partial<ImportOptionsDTO>;
}

export class ImportsApi {
  constructor(private readonly t: Transport) {}

  list(): Promise<Items<ImportDTO>> {
    return this.t.json('GET', '/imports');
  }
  get(id: string): Promise<ImportDTO> {
    return this.t.json('GET', `/imports/${id}`);
  }
  /** Upload CSV text; the response includes headers, a sample and a suggested mapping. */
  upload(filename: string, csv: string): Promise<ImportDTO> {
    return this.t.json('POST', '/imports', { query: { filename }, raw: { body: csv, contentType: 'text/csv; charset=utf-8' } });
  }
  preview(id: string, plan: ImportPlan): Promise<ImportPreviewDTO> {
    return this.t.json('POST', `/imports/${id}/preview`, { body: plan });
  }
  commit(id: string, plan: ImportPlan & { triggerAutomations?: boolean }): Promise<ImportReportDTO> {
    return this.t.json('POST', `/imports/${id}/commit`, { body: plan });
  }
}
