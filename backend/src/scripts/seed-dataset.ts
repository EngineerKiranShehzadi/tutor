import * as fs from 'fs';
import * as path from 'path';
import { processDataset } from '../services/chunk.service';
import { getLectureById } from '../services/lecture.service';
import { logger } from '../utils/logger';

async function main() {
  const lectureId = parseInt(process.argv[2] ?? '1', 10);
  if (isNaN(lectureId)) {
    console.error('Usage: npm run seed:dataset [lectureId]');
    process.exit(1);
  }

  const xlsxPath = path.resolve(__dirname, '../../dataset.xlsx');
  if (!fs.existsSync(xlsxPath)) {
    logger.error(`[SEED] ❌ File not found: ${xlsxPath}`);
    process.exit(1);
  }

  const lecture = await getLectureById(lectureId);
  logger.info(`[SEED] 🎯 Target lecture #${lectureId}: "${lecture.title}" (current status: ${lecture.status})`);

  const buffer = fs.readFileSync(xlsxPath);
  logger.info(`[SEED] 📂 Loaded dataset.xlsx — ${(buffer.length / 1024).toFixed(1)} KB`);

  await processDataset(lectureId, buffer);

  logger.info(`[SEED] ✅ Lecture #${lectureId} is now READY`);
  process.exit(0);
}

main().catch(err => {
  logger.error('[SEED] ❌ Fatal:', err);
  process.exit(1);
});
