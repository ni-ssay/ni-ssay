import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { marked, type Token, type Tokens } from 'marked';
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';

/**
 * Render a Markdown guide to a .docx Word document, embedding the
 * annotated screenshots. Pure JS (docx package), no AI, works offline.
 */
export async function renderDocx(
  markdown: string,
  /** Directory the guide's relative image paths resolve against. */
  baseDir: string,
  outFile: string,
): Promise<void> {
  const tokens = marked.lexer(markdown);
  const children: Paragraph[] = [];
  for (const token of tokens) {
    children.push(...(await blockToParagraphs(token, baseDir)));
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'fs-numbered',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } }, // 11pt
      },
    },
    sections: [{ children }],
  });

  await writeFile(outFile, await Packer.toBuffer(doc));
}

async function blockToParagraphs(
  token: Token,
  baseDir: string,
): Promise<Paragraph[]> {
  switch (token.type) {
    case 'heading': {
      const levels = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
      ];
      return [
        new Paragraph({
          heading: levels[Math.min(token.depth - 1, 3)],
          children: await inlineRuns(token.tokens ?? [], baseDir),
          spacing: { before: 240, after: 120 },
        }),
      ];
    }
    case 'paragraph':
      return [
        new Paragraph({
          children: await inlineRuns(token.tokens ?? [], baseDir),
          spacing: { after: 120 },
        }),
      ];
    case 'list': {
      const out: Paragraph[] = [];
      for (const item of (token as Tokens.List).items) {
        const inner: Token[] = [];
        for (const t of item.tokens) {
          if (t.type === 'text' && 'tokens' in t && t.tokens) inner.push(...t.tokens);
          else inner.push(t);
        }
        // Images inside list items become their own paragraphs after the item.
        const textTokens = inner.filter((t) => t.type !== 'image');
        const imageTokens = inner.filter((t) => t.type === 'image');
        out.push(
          new Paragraph({
            children: await inlineRuns(textTokens, baseDir),
            ...(token.ordered
              ? { numbering: { reference: 'fs-numbered', level: 0 } }
              : { bullet: { level: 0 } }),
            spacing: { after: 80 },
          }),
        );
        for (const img of imageTokens) {
          out.push(...(await blockToParagraphs({ ...img, type: 'paragraph', tokens: [img], text: '' } as Token, baseDir)));
        }
      }
      return out;
    }
    case 'blockquote': {
      const out: Paragraph[] = [];
      for (const t of (token as Tokens.Blockquote).tokens) {
        for (const p of await blockToParagraphs(t, baseDir)) out.push(p);
      }
      return out;
    }
    case 'code':
      return [
        new Paragraph({
          children: [
            new TextRun({ text: (token as Tokens.Code).text, font: 'Consolas', size: 18 }),
          ],
          spacing: { after: 120 },
        }),
      ];
    case 'hr':
      return [new Paragraph({ text: '' })];
    case 'space':
      return [];
    default: {
      const text = 'text' in token ? String((token as { text?: string }).text ?? '') : '';
      return text.trim() ? [new Paragraph({ text })] : [];
    }
  }
}

async function inlineRuns(
  tokens: Token[],
  baseDir: string,
  style: { bold?: boolean; italics?: boolean } = {},
): Promise<(TextRun | ImageRun | ExternalHyperlink)[]> {
  const runs: (TextRun | ImageRun | ExternalHyperlink)[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        if ('tokens' in t && t.tokens?.length) {
          runs.push(...(await inlineRuns(t.tokens, baseDir, style)));
        } else {
          runs.push(new TextRun({ text: (t as Tokens.Text).text, ...style }));
        }
        break;
      case 'strong':
        runs.push(...(await inlineRuns(t.tokens ?? [], baseDir, { ...style, bold: true })));
        break;
      case 'em':
        runs.push(...(await inlineRuns(t.tokens ?? [], baseDir, { ...style, italics: true })));
        break;
      case 'codespan':
        runs.push(new TextRun({ text: (t as Tokens.Codespan).text, font: 'Consolas', ...style }));
        break;
      case 'link': {
        const link = t as Tokens.Link;
        runs.push(
          new ExternalHyperlink({
            link: link.href,
            children: [
              new TextRun({ text: link.text || link.href, style: 'Hyperlink', ...style }),
            ],
          }),
        );
        break;
      }
      case 'image': {
        const img = await imageRun(t as Tokens.Image, baseDir);
        if (img) runs.push(img);
        break;
      }
      case 'br':
        runs.push(new TextRun({ text: '', break: 1 }));
        break;
      default:
        if ('text' in t) runs.push(new TextRun({ text: String((t as { text?: string }).text ?? ''), ...style }));
    }
  }
  return runs;
}

async function imageRun(token: Tokens.Image, baseDir: string): Promise<ImageRun | null> {
  const file = path.resolve(baseDir, token.href);
  const data = await readFile(file).catch(() => null);
  if (!data) return null;
  const ext = path.extname(file).toLowerCase();
  const isJpeg = ext === '.jpg' || ext === '.jpeg';
  const { width, height } =
    (isJpeg ? jpegSize(data) : pngSize(data)) ?? { width: 1280, height: 720 };
  const maxWidth = 560; // fits comfortably on A4 with margins
  const scale = Math.min(1, maxWidth / width);
  return new ImageRun({
    type: isJpeg ? 'jpg' : 'png',
    data,
    transformation: {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    },
  });
}

/** Read dimensions from a PNG header (IHDR chunk). */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Read dimensions from a JPEG's SOF marker. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    // SOF0–SOF15 carry dimensions (except DHT/JPG/DAC markers C4, C8, CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + buf.readUInt16BE(pos + 2);
  }
  return null;
}
