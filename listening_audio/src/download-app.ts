import { readFileSync } from 'node:fs';
export const DOWNLOAD_UI_URI = 'ui://listening-audio/question-download-v1.html';
export function downloadHtml() {
  return readFileSync(new URL('../ui/question-download.html', import.meta.url), 'utf8');
}
