import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPORTS_DIR = join(process.cwd(), 'data', 'reports');
const OUTPUT_FILE = join(process.cwd(), 'public', 'search-index.json');

async function buildSearchIndex() {
  let files;
  try {
    files = await readdir(REPORTS_DIR);
  } catch {
    console.log('No reports directory found, creating empty search index.');
    await writeFile(OUTPUT_FILE, '[]', 'utf-8');
    return;
  }

  const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse();

  const index = [];

  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(REPORTS_DIR, file), 'utf-8');
      const report = JSON.parse(raw);

      const bullishTickers = (report.bullishSignals || []).map(s => s.ticker).filter(Boolean);
      const bearishTickers = (report.bearishSignals || []).map(s => s.ticker).filter(Boolean);
      const monitorTopics = (report.monitorSignals || []).map(s => s.topic).filter(Boolean);

      const allTickers = [...new Set([...bullishTickers, ...bearishTickers])];
      const allTopics = [...new Set(monitorTopics)];

      index.push({
        date: report.date || file.replace('.json', ''),
        totalSources: report.totalSources || 0,
        tickers: allTickers,
        topics: allTopics,
        bullishTickers,
        bearishTickers,
        monitorTopics,
      });
    } catch (e) {
      console.warn(`Skipping ${file}: ${e.message}`);
    }
  }

  await writeFile(OUTPUT_FILE, JSON.stringify(index, null, 2), 'utf-8');
  console.log(`Search index built: ${index.length} reports indexed.`);
}

buildSearchIndex();
