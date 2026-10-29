// Used by rehearse.sh only: one corrected row through the real update pipeline (MERGE) on lecture 6. Local DBs only.
import { exportActiveDataset, prepareDatasetVersion, finishDatasetVersion } from '../../src/services/dataset-version.service';
import * as XLSX from 'xlsx';
(async () => {
  const L = 6;
  const wb = XLSX.read(await exportActiveDataset(L), { type: 'buffer' });
  const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets['dataset']);
  rows[10].answer += ' (corrected in the rehearsal update)';
  const w = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w, XLSX.utils.json_to_sheet(rows), 'dataset');
  const prep = await prepareDatasetVersion(L, XLSX.write(w, { type: 'buffer', bookType: 'xlsx' }) as Buffer, { filename: 'rehearsal.xlsx' });
  if (prep.kind !== 'CREATED') throw new Error('not created: ' + prep.kind);
  console.log('update:', JSON.stringify({ updated: prep.preview.updated, toEmbed: prep.preview.chunksToEmbed }), (await finishDatasetVersion(prep.versionId)).outcome);
  process.exit(0);
})();
