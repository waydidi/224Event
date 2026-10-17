import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { ReceiptAssets } from './pdf.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../../assets/fonts');

/** Receipt fonts and logo read from the repository's assets folder. */
export function nodeReceiptAssets(config: Config): ReceiptAssets {
  return {
    fonts: {
      regular: path.join(FONT_DIR, 'Inter-Regular.otf'),
      medium: path.join(FONT_DIR, 'Inter-Medium.otf'),
      bold: path.join(FONT_DIR, 'Inter-Bold.otf'),
    },
    logo: fs.existsSync(config.receipt.logoPath) ? config.receipt.logoPath : undefined,
  };
}
