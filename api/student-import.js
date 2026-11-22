export const MAX_STUDENT_IMPORT_ROWS = 300;

function studentTableDelimiter(text) {
  let quoted = false;
  let commas = 0;
  let semicolons = 0;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === '\r' || char === '\n') break;
    if (char === '\t') return '\t';
    if (char === ',') commas++;
    if (char === ';') semicolons++;
  }
  return semicolons > 0 && semicolons >= commas ? ';' : ',';
}

function readStudentTable(rawText) {
  const text = String(rawText || '').replace(/^\uFEFF/, '').replace(/^(?:[ \t]*(?:\r\n|\r|\n))+/, '');
  const delimiter = studentTableDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let fieldWasQuoted = false;

  const finishField = () => {
    const value = field.trim();
    row.push(fieldWasQuoted ? value : value.replace(/^'(.*)'$/s, '$1').trim());
    field = '';
    fieldWasQuoted = false;
  };
  const finishRow = () => {
    finishField();
    if (row.some(Boolean)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (char === '"' && !field.trim()) {
      quoted = true;
      fieldWasQuoted = true;
    } else if (char === delimiter) {
      finishField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      finishRow();
      // Keep enough records to detect an overflow even when there is a header.
      if (rows.length === MAX_STUDENT_IMPORT_ROWS + 2) return rows;
    } else {
      field += char;
    }
  }
  finishRow();
  return rows;
}

export function parseStudentImportRows(rawText) {
  const [first, ...rest] = readStudentTable(rawText);
  if (!first) return [];

  const header = first.map(value => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const columns = {
    name: header.findIndex(value => /^(nome|name|aluno)$/.test(value)),
    phone: header.findIndex(value => /^(whatsapp|telefone|celular|phone|fone|tel)$/.test(value)),
    email: header.findIndex(value => /^(email|e-mail|mail)$/.test(value)),
    goal: header.findIndex(value => /^(objetivo|goal|meta)$/.test(value)),
    notes: header.findIndex(value => /^(notas|notes|observacao|observacoes|obs)$/.test(value))
  };
  const hasHeader = header.some(value => /^(nome|name|aluno|whatsapp|telefone|celular|phone|email|e-mail|objetivo|goal)$/.test(value));
  const rows = hasHeader ? rest : [first, ...rest];
  const { name, phone, email, goal, notes } = hasHeader
    ? columns
    : { name: 0, phone: 1, email: 2, goal: 3, notes: 4 };
  return rows.map(row => ({
    name: row[Math.max(name, 0)] || '',
    phone: row[phone] || '',
    email: row[email] || '',
    goal: row[goal] || '',
    notes: row[notes] || ''
  }));
}
