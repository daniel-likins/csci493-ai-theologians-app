import type { AttachmentDto, AttachmentKind, ExtractionStatus } from '../../../shared/types.ts';

export interface AttachmentRow {
  id: string;
  workspace_id: string | null;
  conversation_id: string | null;
  filename: string;
  mime_type: string;
  kind: AttachmentKind;
  size_bytes: number;
  sha256: string;
  extraction_status: ExtractionStatus;
  extraction_detail: string | null;
  page_count: number | null;
  char_count: number | null;
  created_at: string;
}

export function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    kind: row.kind,
    sizeBytes: row.size_bytes,
    extractionStatus: row.extraction_status,
    extractionDetail: row.extraction_detail,
    pageCount: row.page_count,
    charCount: row.char_count,
    createdAt: row.created_at,
  };
}
