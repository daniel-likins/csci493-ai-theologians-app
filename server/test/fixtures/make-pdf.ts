/** Build a small, valid PDF for tests. A `null` page has only a filled rectangle (no text layer). */
export function makePdf(pages: (string | null)[]): Buffer {
  const escape = (text: string): string => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects: { num: number; body: string }[] = [{ num: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }];
  const pageNums: number[] = [];
  let next = 4;
  for (const text of pages) {
    const pageNum = next++;
    const contentNum = next++;
    pageNums.push(pageNum);
    const stream =
      text === null
        ? '0.2 0.4 0.8 rg 72 72 300 300 re f'
        : text
            .split('\n')
            .map((line, i) => `BT /F1 12 Tf 72 ${740 - i * 16} Td (${escape(line)}) Tj ET`)
            .join('\n');
    objects.push({
      num: pageNum,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`,
    });
    objects.push({ num: contentNum, body: `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream` });
  }
  objects.push({ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  objects.push({ num: 2, body: `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>` });
  objects.sort((a, b) => a.num - b.num);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets[obj.num] = Buffer.byteLength(out, 'latin1');
    out += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  const size = objects.length + 1;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
