/**
 * api/prescription-pdf.js
 *
 * Gerador puro em JavaScript de Ficha / Plano de Treino completo em PDF (A4, PDF 1.4),
 * com White-Label da Academia ou Personal Trainer, sem dependências externas.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 36;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const MARGIN_TOP = 36;
const FOOTER_Y = PAGE_H - 34;
const MAX_CONTENT_Y = FOOTER_Y - 18;

const WEEKDAYS_PT = {
  0: 'Domingo',
  1: 'Segunda-feira',
  2: 'Terça-feira',
  3: 'Quarta-feira',
  4: 'Quinta-feira',
  5: 'Sexta-feira',
  6: 'Sábado'
};

const WEEKDAYS_SHORT = [
  { d: 1, short: 'Seg' },
  { d: 2, short: 'Ter' },
  { d: 3, short: 'Qua' },
  { d: 4, short: 'Qui' },
  { d: 5, short: 'Sex' },
  { d: 6, short: 'Sáb' },
  { d: 0, short: 'Dom' }
];

const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];

const WIN1252_EXTRA = {
  0x20AC: 0x80,
  0x201A: 0x82,
  0x0192: 0x83,
  0x201E: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02C6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8A,
  0x2039: 0x8B,
  0x0152: 0x8C,
  0x017D: 0x8E,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201C: 0x93,
  0x201D: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02DC: 0x98,
  0x2122: 0x99,
  0x0161: 0x9A,
  0x203A: 0x9B,
  0x0153: 0x9C,
  0x017E: 0x9E,
  0x0178: 0x9F
};

function sanitizeForPdf(raw) {
  return String(raw ?? '')
    .replace(/\u2192/g, '->')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    .replace(/\u2248/g, '~')
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\t]+/g, ' ');
}

function charToWin1252(code) {
  if (code >= 0x20 && code <= 0xFF) {
    if (code >= 0x7F && code <= 0x9F) return null;
    return code;
  }
  return WIN1252_EXTRA[code] ?? null;
}

function charWidthUnits(ch, bold) {
  const clean = ch.normalize('NFD').replace(/\p{M}/gu, '');
  const code = (clean.charCodeAt(0) || 32);
  let base = 556;
  if (code >= 32 && code <= 126) {
    base = HELVETICA_WIDTHS[code - 32];
  } else if (ch === '—') {
    base = 1000;
  } else if (ch === '–') {
    base = 556;
  } else if (ch === '•' || ch === '·') {
    base = 350;
  } else if (ch === '×') {
    base = 584;
  } else if (ch === '…') {
    base = 1000;
  }
  return bold ? base * 1.07 : base;
}

function measureText(text, fontSize, bold = false) {
  const str = sanitizeForPdf(text);
  let units = 0;
  for (const ch of str) {
    if (charToWin1252(ch.codePointAt(0)) === null) continue;
    units += charWidthUnits(ch, bold);
  }
  return (units * fontSize) / 1000;
}

function wrapText(text, maxWidth, fontSize, bold = false) {
  const clean = sanitizeForPdf(text).trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n+/);
  const lines = [];

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureText(candidate, fontSize, bold) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (measureText(word, fontSize, bold) <= maxWidth) {
        current = word;
      } else {
        let part = '';
        for (const ch of word) {
          if (measureText(part + ch, fontSize, bold) > maxWidth && part) {
            lines.push(part);
            part = ch;
          } else {
            part += ch;
          }
        }
        current = part;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function pdfStr(text) {
  const s = sanitizeForPdf(text);
  let out = '(';
  for (const ch of s) {
    const b = charToWin1252(ch.codePointAt(0));
    if (b === null) continue;
    if (b === 0x28 || b === 0x29 || b === 0x5C) {
      out += '\\' + String.fromCharCode(b);
    } else if (b < 0x20 || b >= 0x7F) {
      out += '\\' + b.toString(8).padStart(3, '0');
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out + ')';
}

function hexToRgb(hex, fallback = [249, 115, 22]) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return fallback.map(v => +(v / 255).toFixed(4));
  let h = m[1];
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [
    +(parseInt(h.slice(0, 2), 16) / 255).toFixed(4),
    +(parseInt(h.slice(2, 4), 16) / 255).toFixed(4),
    +(parseInt(h.slice(4, 6), 16) / 255).toFixed(4)
  ];
}

function rgbLuminance(rgb) {
  const lin = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function mixRgb(rgbA, rgbB, ratio) {
  const t = Math.max(0, Math.min(1, ratio));
  return [0, 1, 2].map(i => +(rgbA[i] * (1 - t) + rgbB[i] * t).toFixed(4));
}

function slugifyFilePart(raw) {
  return String(raw || 'aluno')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'aluno';
}

function formatWeightLabel(ex) {
  const wNum = Number(Array.isArray(ex?.sets) ? ex.sets[0]?.w : ex?.weight);
  if (!Number.isFinite(wNum) || wNum <= 0) return 'Progressiva';
  const numStr = Number.isInteger(wNum)
    ? wNum.toLocaleString('pt-BR')
    : wNum.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${numStr} kg`;
}

function formatSetsRepsLabel(ex) {
  const setsCount = Array.isArray(ex?.sets) ? ex.sets.length : Number(ex?.sets || 3);
  if (ex?.repsMin && ex?.repsMax && Number(ex.repsMin) !== Number(ex.repsMax)) {
    return `${setsCount} × ${ex.repsMin}-${ex.repsMax}`;
  }
  const repVal = Array.isArray(ex?.sets) && ex.sets[0]?.r !== undefined && ex.sets[0]?.r !== ''
    ? ex.sets[0].r
    : (ex?.reps ?? 10);
  return `${setsCount} × ${repVal}`;
}

class PdfDoc {
  constructor({ primaryRgb, gymName, footerBrand }) {
    this.pages = [];
    this.cmds = [];
    this.cursorY = MARGIN_TOP;
    this.primaryRgb = primaryRgb;
    this.gymName = gymName;
    this.footerBrand = footerBrand;
    this.newPage();
  }

  newPage() {
    if (this.cmds.length > 0) {
      this.pages.push(this.cmds);
    }
    this.cmds = [];
    this.cursorY = MARGIN_TOP;
  }

  ensureSpace(neededHeight, onNewPage) {
    if (this.cursorY + neededHeight <= MAX_CONTENT_Y) return false;
    this.newPage();
    if (typeof onNewPage === 'function') onNewPage();
    return true;
  }

  toPdfY(topY) {
    return +(PAGE_H - topY).toFixed(2);
  }

  rect(x, topY, w, h, { fill, stroke, lineWidth = 0.75, radius = 0 } = {}) {
    const x1 = +x.toFixed(2);
    const yBottom = +(PAGE_H - topY - h).toFixed(2);
    const yTop = +(PAGE_H - topY).toFixed(2);
    const x2 = +(x + w).toFixed(2);

    this.cmds.push('q');
    if (fill) this.cmds.push(`${fill[0]} ${fill[1]} ${fill[2]} rg`);
    if (stroke) this.cmds.push(`${stroke[0]} ${stroke[1]} ${stroke[2]} RG`);
    this.cmds.push(`${lineWidth} w`);

    if (radius > 0) {
      const r = Math.min(radius, w / 2, h / 2);
      const k = +(r * 0.55228475).toFixed(2);
      const pathCmds = [
        `${(x1 + r).toFixed(2)} ${yBottom} m`,
        `${(x2 - r).toFixed(2)} ${yBottom} l`,
        `${(x2 - r + k).toFixed(2)} ${yBottom} ${x2} ${(yBottom + r - k).toFixed(2)} ${x2} ${(yBottom + r).toFixed(2)} c`,
        `${x2} ${(yTop - r).toFixed(2)} l`,
        `${x2} ${(yTop - r + k).toFixed(2)} ${(x2 - r + k).toFixed(2)} ${yTop} ${(x2 - r).toFixed(2)} ${yTop} c`,
        `${(x1 + r).toFixed(2)} ${yTop} l`,
        `${(x1 + r - k).toFixed(2)} ${yTop} ${x1} ${(yTop - r + k).toFixed(2)} ${x1} ${(yTop - r).toFixed(2)} c`,
        `${x1} ${(yBottom + r).toFixed(2)} l`,
        `${x1} ${(yBottom + r - k).toFixed(2)} ${(x1 + r - k).toFixed(2)} ${yBottom} ${(x1 + r).toFixed(2)} ${yBottom} c`,
        'h'
      ];
      this.cmds.push(pathCmds.join(' '));
    } else {
      this.cmds.push(`${x1} ${yBottom} ${w.toFixed(2)} ${h.toFixed(2)} re`);
    }

    if (fill && stroke) this.cmds.push('B');
    else if (fill) this.cmds.push('f');
    else this.cmds.push('S');
    this.cmds.push('Q');
  }

  line(x1, topY1, x2, topY2, stroke = [0.89, 0.91, 0.94], lineWidth = 0.75) {
    this.cmds.push(
      `q ${stroke[0]} ${stroke[1]} ${stroke[2]} RG ${lineWidth} w ` +
      `${x1.toFixed(2)} ${this.toPdfY(topY1)} m ${x2.toFixed(2)} ${this.toPdfY(topY2)} l S Q`
    );
  }

  text(str, x, topY, { size = 10, bold = false, italic = false, color = [0.07, 0.09, 0.15], align = 'left' } = {}) {
    const fontRef = bold ? '/F2' : italic ? '/F3' : '/F1';
    let drawX = x;
    if (align === 'right') {
      drawX = x - measureText(str, size, bold);
    } else if (align === 'center') {
      drawX = x - measureText(str, size, bold) / 2;
    }
    const baselineTopY = topY + size * 0.8;
    this.cmds.push(
      `BT ${fontRef} ${size} Tf ${color[0]} ${color[1]} ${color[2]} rg ` +
      `${drawX.toFixed(2)} ${this.toPdfY(baselineTopY)} Td ${pdfStr(str)} Tj ET`
    );
  }

  textLines(lines, x, startTopY, lineHeight, opts) {
    lines.forEach((ln, idx) => {
      this.text(ln, x, startTopY + idx * lineHeight, opts);
    });
  }

  finalize() {
    if (this.cmds.length > 0) {
      this.pages.push(this.cmds);
    }
    const total = this.pages.length;

    this.pages = this.pages.map((pageCmds, i) => {
      const cmds = [...pageCmds];
      const yLine = FOOTER_Y;
      cmds.push(`q 0.89 0.91 0.94 RG 0.6 w ${MARGIN_X} ${this.toPdfY(yLine)} m ${MARGIN_X + CONTENT_W} ${this.toPdfY(yLine)} l S Q`);
      const textTopY = yLine + 7;
      const baseline = this.toPdfY(textTopY + 8 * 0.8);
      const leftLabel = `Plano de treino gerado em ${this.gymName}`;
      const rightLabel = `${this.footerBrand} · Página ${i + 1} de ${total}`;
      const rightX = MARGIN_X + CONTENT_W - measureText(rightLabel, 8.5, false);
      cmds.push(`BT /F1 8.5 Tf 0.42 0.45 0.50 rg ${MARGIN_X.toFixed(2)} ${baseline} Td ${pdfStr(leftLabel)} Tj ET`);
      cmds.push(`BT /F1 8.5 Tf 0.42 0.45 0.50 rg ${rightX.toFixed(2)} ${baseline} Td ${pdfStr(rightLabel)} Tj ET`);
      return cmds.join('\n');
    });

    const encoder = new TextEncoder();
    const chunks = [];
    let byteOffset = 0;
    const offsets = [0];

    const pushAscii = str => {
      const b = encoder.encode(str);
      chunks.push(b);
      byteOffset += b.length;
    };
    const pushBytes = b => {
      chunks.push(b);
      byteOffset += b.length;
    };

    const startObj = () => {
      const id = offsets.length;
      offsets.push(byteOffset);
      pushAscii(`${id} 0 obj\n`);
      return id;
    };

    pushAscii('%PDF-1.4\n%');
    pushBytes(new Uint8Array([0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    const f1Id = 3;
    const f2Id = 4;
    const f3Id = 5;
    const firstPageObjId = 6;
    const pageObjIds = this.pages.map((_, idx) => firstPageObjId + idx * 2);

    startObj();
    pushAscii('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    startObj();
    pushAscii(`<< /Type /Pages /Count ${pageObjIds.length} /Kids [${pageObjIds.map(id => `${id} 0 R`).join(' ')}] >>\nendobj\n`);

    startObj();
    pushAscii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
    startObj();
    pushAscii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n');
    startObj();
    pushAscii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>\nendobj\n');

    const resourceDict = `<< /Font << /F1 ${f1Id} 0 R /F2 ${f2Id} 0 R /F3 ${f3Id} 0 R >> >>`;

    this.pages.forEach((streamStr, idx) => {
      const pageId = firstPageObjId + idx * 2;
      const contentId = pageId + 1;
      startObj();
      pushAscii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources ${resourceDict} /Contents ${contentId} 0 R >>\nendobj\n`
      );
      const streamBytes = encoder.encode(streamStr);
      startObj();
      pushAscii(`<< /Length ${streamBytes.length} >>\nstream\n`);
      pushBytes(streamBytes);
      pushAscii('\nendstream\nendobj\n');
    });

    const xrefStart = byteOffset;
    pushAscii(`xref\n0 ${offsets.length}\n`);
    pushAscii('0000000000 65535 f \n');
    for (let i = 1; i < offsets.length; i++) {
      pushAscii(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    }
    pushAscii(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const out = new Uint8Array(byteOffset);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
}

/**
 * Gera os bytes e Base64 de um PDF A4 consolidado com todas as fichas prescritas do aluno.
 */
export function buildPrescriptionPlanPdfBytes({
  student = {},
  routines = [],
  week = {},
  tenant = {},
  branding = {},
  trainerName = '',
  appUrl = ''
}) {
  const items = (Array.isArray(routines) ? routines : [])
    .map(item => {
      const rObj = item?.routine || item;
      if (!rObj || typeof rObj !== 'object') return null;
      const explicitDays = Array.isArray(item?.days) && item.days.length > 0 ? item.days : null;
      const resolvedDays = explicitDays
        || (week && typeof week === 'object' && rObj.id
          ? [1, 2, 3, 4, 5, 6, 0].filter(d => [].concat(week[String(d)] || []).includes(rObj.id))
          : []);
      return { routine: rObj, days: resolvedDays };
    })
    .filter(Boolean);

  const gymName = String(branding?.gymName || tenant?.name || 'Rit Performance').trim();
  const slogan = String(branding?.slogan || '').trim();
  const primaryHex = /^#[0-9a-fA-F]{3,6}$/.test(String(branding?.primaryColor || '').trim())
    ? String(branding.primaryColor).trim()
    : '#f97316';
  const primaryRgb = hexToRgb(primaryHex);
  const isBrightAccent = rgbLuminance(primaryRgb) > 0.45;
  const accentInkRgb = isBrightAccent ? mixRgb(primaryRgb, [0.07, 0.09, 0.15], 0.58) : primaryRgb;
  const badgeInkRgb = isBrightAccent ? [0.07, 0.09, 0.15] : [1, 1, 1];

  const darkText = [0.07, 0.09, 0.15];
  const mutedText = [0.42, 0.45, 0.50];
  const subText = [0.22, 0.25, 0.32];
  const cardBg = [0.975, 0.98, 0.985];
  const borderCol = [0.89, 0.91, 0.94];
  const softTint = mixRgb([1, 1, 1], primaryRgb, 0.12);

  const contactLine = [
    branding?.contactPhone || tenant?.phone || '',
    branding?.instagram ? (String(branding.instagram).startsWith('@') ? branding.instagram : `@${branding.instagram}`) : '',
    branding?.address || ''
  ].filter(Boolean).join(' · ');

  const todayStr = new Date().toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });

  const doc = new PdfDoc({
    primaryRgb,
    gymName,
    footerBrand: 'App Rit · Treino Inteligente'
  });

  // --- CABEÇALHO WHITE-LABEL ---
  const headY = doc.cursorY;
  const logoSize = 42;
  doc.rect(MARGIN_X, headY, logoSize, logoSize, { fill: primaryRgb, radius: 8 });
  doc.text(gymName.slice(0, 1).toUpperCase() || 'R', MARGIN_X + logoSize / 2, headY + 12, {
    size: 18,
    bold: true,
    color: badgeInkRgb,
    align: 'center'
  });

  const brandTextX = MARGIN_X + logoSize + 12;
  doc.text(gymName, brandTextX, headY + 3, { size: 15, bold: true, color: darkText });
  let subOffset = 22;
  if (slogan) {
    const slLines = wrapText(slogan, 250, 8.5);
    doc.text(slLines[0] || '', brandTextX, headY + subOffset, { size: 8.5, color: mutedText });
    subOffset += 11;
  }
  if (contactLine) {
    const ctLines = wrapText(contactLine, 260, 8);
    doc.text(ctLines[0] || '', brandTextX, headY + subOffset, { size: 8, color: mutedText });
  }

  const tagStr = 'PLANO DE TREINO OFICIAL';
  const tagW = measureText(tagStr, 8, true) + 16;
  doc.rect(MARGIN_X + CONTENT_W - tagW, headY + 2, tagW, 18, { fill: [0.95, 0.96, 0.97], radius: 9 });
  doc.text(tagStr, MARGIN_X + CONTENT_W - tagW / 2, headY + 6.5, { size: 8, bold: true, color: subText, align: 'center' });
  doc.text(`Emitido em ${todayStr}`, MARGIN_X + CONTENT_W, headY + 26, { size: 8.5, color: mutedText, align: 'right' });

  doc.cursorY = headY + 52;
  doc.line(MARGIN_X, doc.cursorY, MARGIN_X + CONTENT_W, doc.cursorY, primaryRgb, 2.2);
  doc.cursorY += 14;

  // --- CARD DO ALUNO ---
  const studentName = String(student?.name || 'Aluno').trim();
  const nameLines = wrapText(studentName, CONTENT_W - 24, 14, true).slice(0, 2);
  const nameOffset = Math.max(0, (nameLines.length - 1) * 16);
  const hasUrlLine = Boolean(appUrl);
  const studentBoxH = 66 + nameOffset + (hasUrlLine ? 22 : 0);
  const sbY = doc.cursorY;
  doc.rect(MARGIN_X, sbY, CONTENT_W, studentBoxH, { fill: cardBg, stroke: borderCol, radius: 8 });
  doc.textLines(nameLines, MARGIN_X + 12, sbY + 11, 16, { size: 14, bold: true, color: darkText });

  const colW3 = (CONTENT_W - 24) / 3;
  const metaItems = [
    ['OBJETIVO', student?.goal || 'Hipertrofia & Condicionamento'],
    ['PROFESSOR', trainerName || 'Equipe Técnica'],
    ['PROGRAMAÇÃO', `${items.length} ${items.length === 1 ? 'ficha ativa' : 'fichas ativas'}`]
  ];
  metaItems.forEach(([lbl, val], idx) => {
    const mx = MARGIN_X + 12 + idx * colW3;
    doc.text(lbl, mx, sbY + 34 + nameOffset, { size: 7.5, bold: true, color: mutedText });
    const valLine = wrapText(val, colW3 - 8, 9.5, true)[0] || '—';
    doc.text(valLine, mx, sbY + 45 + nameOffset, { size: 9.5, bold: true, color: darkText });
  });

  if (hasUrlLine) {
    const sepY = sbY + 64 + nameOffset;
    doc.line(MARGIN_X + 12, sepY, MARGIN_X + CONTENT_W - 12, sepY, borderCol, 0.6);
    doc.text(`Vídeos de execução e registro de cargas no App Rit: ${appUrl}`, MARGIN_X + 12, sepY + 6, {
      size: 8.5,
      color: accentInkRgb
    });
  }
  doc.cursorY = sbY + studentBoxH + 14;

  // --- AGENDA SEMANAL ---
  const drawSectionTitle = title => {
    doc.ensureSpace(34);
    doc.text(title, MARGIN_X, doc.cursorY, { size: 11.5, bold: true, color: darkText });
    doc.cursorY += 16;
    doc.line(MARGIN_X, doc.cursorY, MARGIN_X + CONTENT_W, doc.cursorY, borderCol, 0.8);
    doc.cursorY += 10;
  };

  drawSectionTitle('Agenda Semanal de Treinos');
  const dayGap = 5;
  const dayW = (CONTENT_W - dayGap * 6) / 7;
  const dayCardData = WEEKDAYS_SHORT.map(w => {
    const names = items
      .filter(it => it.days.includes(w.d) || [].concat(week?.[String(w.d)] || []).includes(it.routine.id))
      .map(it => it.routine.name);
    const uniqueNames = [...new Set(names)];
    const label = uniqueNames.length ? uniqueNames.join(', ') : 'Descanso';
    const lines = wrapText(label, dayW - 8, 7.5);
    return { short: w.short, active: uniqueNames.length > 0, lines };
  });
  const maxDayLines = Math.max(1, ...dayCardData.map(d => d.lines.length));
  const weekH = Math.max(38, 20 + maxDayLines * 9.5 + 6);
  doc.ensureSpace(weekH + 14);
  const wy = doc.cursorY;
  dayCardData.forEach((d, idx) => {
    const dx = MARGIN_X + idx * (dayW + dayGap);
    doc.rect(dx, wy, dayW, weekH, {
      fill: d.active ? softTint : cardBg,
      stroke: d.active ? accentInkRgb : borderCol,
      lineWidth: d.active ? 0.9 : 0.6,
      radius: 5
    });
    doc.text(d.short, dx + dayW / 2, wy + 5.5, {
      size: 8.5,
      bold: true,
      color: d.active ? accentInkRgb : subText,
      align: 'center'
    });
    doc.textLines(d.lines, dx + dayW / 2, wy + 18, 9.5, {
      size: 7.5,
      color: d.active ? darkText : mutedText,
      align: 'center'
    });
  });
  doc.cursorY += weekH + 16;

  // --- TABELA COMPLETA DE CADA FICHA (SEM TRUNCAR EXERCÍCIOS) ---
  drawSectionTitle('Detalhamento Completo das Fichas');

  items.forEach(({ routine, days }, rIdx) => {
    const scheduled = [...new Set(days)]
      .map(d => WEEKDAYS_PT[Number(d)] || '')
      .filter(Boolean);
    const profLabel = routine?.prescribedBy?.name || routine?.prescribedBy?.trainerName || trainerName;
    const subMeta = [
      scheduled.length ? `Dias: ${scheduled.join(', ')}` : 'Ficha complementar / Livre',
      profLabel ? `Prof. ${profLabel}` : ''
    ].filter(Boolean).join(' · ');

    const drawRoutineHead = continued => {
      const hy = doc.cursorY;
      doc.rect(MARGIN_X, hy, CONTENT_W, 30, { fill: [0.95, 0.96, 0.97], stroke: borderCol, radius: 5 });
      const heading = `${items.length > 1 ? `${rIdx + 1}. ` : ''}${routine.name || 'Ficha de Treino'}${continued ? ' (continuação)' : ''}`;
      doc.text(heading, MARGIN_X + 10, hy + 5.5, {
        size: 10.5,
        bold: true,
        color: darkText
      });
      doc.text(wrapText(subMeta, CONTENT_W - 115, 8)[0] || '', MARGIN_X + 10, hy + 18.5, {
        size: 8,
        color: mutedText
      });
      const exCount = (routine.ex || []).length;
      doc.text(`${exCount} ${exCount === 1 ? 'exercício' : 'exercícios'}`, MARGIN_X + CONTENT_W - 10, hy + 10, {
        size: 8.5,
        bold: true,
        color: accentInkRgb,
        align: 'right'
      });
      doc.cursorY += 30;

      const thY = doc.cursorY;
      doc.rect(MARGIN_X, thY, CONTENT_W, 18, { fill: cardBg, stroke: borderCol });
      doc.text('#', MARGIN_X + 8, thY + 5, { size: 7.5, bold: true, color: mutedText });
      doc.text('EXERCÍCIO', MARGIN_X + 30, thY + 5, { size: 7.5, bold: true, color: mutedText });
      doc.text('SÉRIES × REPS', MARGIN_X + 368, thY + 5, { size: 7.5, bold: true, color: mutedText, align: 'right' });
      doc.text('CARGA', MARGIN_X + 445, thY + 5, { size: 7.5, bold: true, color: mutedText, align: 'right' });
      doc.text('DESCANSO', MARGIN_X + CONTENT_W - 8, thY + 5, { size: 7.5, bold: true, color: mutedText, align: 'right' });
      doc.cursorY += 18;
    };

    doc.ensureSpace(78);
    drawRoutineHead(false);

    const slots = Array.isArray(routine.ex) ? routine.ex : [];
    if (!slots.length) {
      doc.rect(MARGIN_X, doc.cursorY, CONTENT_W, 24, { stroke: borderCol });
      doc.text('Sem exercícios cadastrados nesta ficha.', MARGIN_X + 10, doc.cursorY + 7, { size: 8.5, color: mutedText });
      doc.cursorY += 34;
      return;
    }

    slots.forEach((slot, sIdx) => {
      const titleStr = slot.bpLabel ? `${slot.name || slot.id} (${slot.bpLabel})` : (slot.name || slot.id || 'Exercício');
      const nameLines = wrapText(titleStr, 250, 9, true);
      const noteLines = slot.note ? wrapText(`Obs: ${slot.note}`, 250, 8, false) : [];
      const rowH = Math.max(20, nameLines.length * 11 + noteLines.length * 10 + 8);

      doc.ensureSpace(rowH, () => drawRoutineHead(true));

      const ry = doc.cursorY;
      if (sIdx % 2 === 1) doc.rect(MARGIN_X, ry, CONTENT_W, rowH, { fill: [0.99, 0.992, 0.995] });
      doc.line(MARGIN_X, ry, MARGIN_X, ry + rowH, borderCol, 0.6);
      doc.line(MARGIN_X + CONTENT_W, ry, MARGIN_X + CONTENT_W, ry + rowH, borderCol, 0.6);
      doc.line(MARGIN_X, ry + rowH, MARGIN_X + CONTENT_W, ry + rowH, borderCol, 0.5);

      doc.text(String(sIdx + 1), MARGIN_X + 8, ry + 5, { size: 8.5, color: mutedText });
      doc.textLines(nameLines, MARGIN_X + 30, ry + 5, 11, { size: 9, bold: true, color: darkText });
      if (noteLines.length) {
        doc.textLines(noteLines, MARGIN_X + 30, ry + 5 + nameLines.length * 11, 10, {
          size: 8,
          italic: true,
          color: mutedText
        });
      }
      doc.text(formatSetsRepsLabel(slot), MARGIN_X + 368, ry + 5, {
        size: 9,
        color: darkText,
        align: 'right'
      });
      doc.text(formatWeightLabel(slot), MARGIN_X + 445, ry + 5, {
        size: 9,
        color: darkText,
        align: 'right'
      });
      doc.text(`${slot.restSec || 90}s`, MARGIN_X + CONTENT_W - 8, ry + 5, {
        size: 9,
        color: mutedText,
        align: 'right'
      });
      doc.cursorY += rowH;
    });

    doc.cursorY += 14;
  });

  const bytes = doc.finalize();
  const base64 = Buffer.from(bytes).toString('base64');
  const filename = `ficha-treino-${slugifyFilePart(studentName)}.pdf`;
  return { bytes, base64, filename };
}
