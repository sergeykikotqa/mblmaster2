import fs from 'node:fs';
import path from 'node:path';

type UnsupportedProjectBlockPayload = {
  slug: string;
  type: string;
  index: number;
  block: unknown;
};

export const recordUnsupportedProjectBlock = ({
  slug,
  type,
  index,
  block,
}: UnsupportedProjectBlockPayload): void => {
  const filePath = path.resolve(process.cwd(), 'tmp', 'unsupported-blocks.json');
  const key = `${slug}:${type}:${index}`;

  try {
    const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];
    const safeExisting = Array.isArray(existing) ? existing : [];

    if (!safeExisting.some((item) => item && item.key === key)) {
      const entry = { key, slug, type, index, block };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify([...safeExisting, entry], null, 2), 'utf8');
    }
  } catch (error) {
    console.warn(`[blocks] Failed to record unsupported block: ${type} (${slug}).`, error);
  }
};
