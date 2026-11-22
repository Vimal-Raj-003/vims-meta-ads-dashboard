const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ============================================================================
// Minimal zero-dependency OpenXML (.xlsx) Generator & Reader + CSV Parser
// Built for Node.js 24+ using built-in node:zlib
// ============================================================================

// CRC32 Table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Create a valid ZIP archive buffer from an array of { name: string, data: Buffer | string }
 */
function createZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const uncompressed = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const compressed = zlib.deflateRawSync(uncompressed);
    const crc = crc32(uncompressed);

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Signature
    localHeader.writeUInt16LE(20, 4);         // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // General purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(8, 8);          // Compression method (8 = deflate)
    localHeader.writeUInt16LE(0, 10);         // Mod time
    localHeader.writeUInt16LE(0x5721, 12);    // Mod date
    localHeader.writeUInt32LE(crc, 14);       // CRC32
    localHeader.writeUInt32LE(compressed.length, 18);   // Compressed size
    localHeader.writeUInt32LE(uncompressed.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);      // File name length
    localHeader.writeUInt16LE(0, 28);         // Extra field length

    localParts.push(localHeader, nameBuf, compressed);

    // Central Directory File Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Signature
    centralHeader.writeUInt16LE(20, 4);         // Version made by
    centralHeader.writeUInt16LE(20, 6);         // Version needed
    centralHeader.writeUInt16LE(0x0800, 8);     // Flag (UTF-8)
    centralHeader.writeUInt16LE(8, 10);         // Compression method
    centralHeader.writeUInt16LE(0, 12);         // Mod time
    centralHeader.writeUInt16LE(0x5721, 14);    // Mod date
    centralHeader.writeUInt32LE(crc, 16);       // CRC32
    centralHeader.writeUInt32LE(compressed.length, 20);   // Compressed size
    centralHeader.writeUInt32LE(uncompressed.length, 24); // Uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28);      // File name length
    centralHeader.writeUInt16LE(0, 30);         // Extra field length
    centralHeader.writeUInt16LE(0, 32);         // Comment length
    centralHeader.writeUInt16LE(0, 34);         // Disk number
    centralHeader.writeUInt16LE(0, 36);         // Internal attrs
    centralHeader.writeUInt32LE(0, 38);         // External attrs
    centralHeader.writeUInt32LE(offset, 42);    // Relative offset of local header

    centralParts.push(centralHeader, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);               // EOCD signature
  eocd.writeUInt16LE(0, 4);                        // Disk number
  eocd.writeUInt16LE(0, 6);                        // Disk with central dir
  eocd.writeUInt16LE(files.length, 8);             // Entries on disk
  eocd.writeUInt16LE(files.length, 10);            // Total entries
  eocd.writeUInt32LE(centralBuffer.length, 12);    // Size of central dir
  eocd.writeUInt32LE(offset, 16);                  // Offset of central dir
  eocd.writeUInt16LE(0, 20);                       // Comment length

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

/**
 * Extract files from a ZIP buffer into { [filename]: Buffer }
 */
function readZipBuffer(zipBuf) {
  const entries = {};
  // Find End of Central Directory (EOCD)
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65557); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP or XLSX file (EOCD not found)');
  }

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  let centralOffset = zipBuf.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < totalEntries; i++) {
    const sig = zipBuf.readUInt32LE(centralOffset);
    if (sig !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(centralOffset + 10);
    const compSize = zipBuf.readUInt32LE(centralOffset + 20);
    const nameLen = zipBuf.readUInt16LE(centralOffset + 28);
    const extraLen = zipBuf.readUInt16LE(centralOffset + 30);
    const commentLen = zipBuf.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(centralOffset + 42);

    const fileName = zipBuf.subarray(centralOffset + 46, centralOffset + 46 + nameLen).toString('utf8');
    centralOffset += 46 + nameLen + extraLen + commentLen;

    const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawData = zipBuf.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      entries[fileName] = rawData;
    } else if (method === 8) {
      entries[fileName] = zlib.inflateRawSync(rawData);
    }
  }
  return entries;
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // strip invalid XML 1.0 control chars except tab, LF, CR
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Prevent spreadsheet formula injection:
 * Any text string starting with =, +, -, @, tab, or CR is stored as an explicit inline string
 * and prefixed with an apostrophe or safe neutralizer if needed, or stored strictly as <c t="inlineStr">
 * In OpenXML, <c t="inlineStr"><is><t>...</t></is></c> is NEVER evaluated as a formula by Excel!
 * Even so, if a user string begins with =, +, -, @, we also prepend a leading single quote or space if unsafe,
 * or sanitize so Excel doesn't warn or execute if converted to CSV.
 */
function sanitizeFormulaText(val) {
  const s = String(val ?? '');
  if (/^[=+\-@\t\r]/.test(s)) {
    return `'${s}`;
  }
  return s;
}

function colIndexToLetter(index) {
  let temp = index + 1;
  let letter = '';
  while (temp > 0) {
    let rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter;
}

/**
 * Generate a multi-sheet .xlsx buffer.
 * sheets: Array of {
 *   name: string,
 *   columns: Array<{ header: string, key: string, width?: number, type?: 'text'|'number'|'currency'|'percent'|'integer' }>,
 *   rows: Array<Object | Array>,
 *   preamble?: Array<Array<{ value: any, style?: string }>>
 * }
 *
 * Styles index in styles.xml:
 * 0 = Default cell
 * 1 = Header cell (bold, dark navy fill, white text)
 * 2 = Section title / Preamble bold
 * 3 = Currency / Decimal (0.00)
 * 4 = Integer (#,##0)
 * 5 = Percent (0.00"%")
 * 6 = Text forced (@)
 * 7 = Highlight/Total row bold
 */
function buildXlsxBuffer(sheets) {
  const files = [];

  // 1. [Content_Types].xml
  const sheetOverrides = sheets.map((_, idx) =>
    `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('\n  ');

  files.push({
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheetOverrides}
</Types>`
  });

  // 2. _rels/.rels
  files.push({
    name: '_rels/.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  });

  // 3. xl/_rels/workbook.xml.rels
  const wbRels = sheets.map((_, idx) =>
    `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`
  ).join('\n  ');

  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${wbRels}
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  });

  // 4. xl/workbook.xml
  const wbSheets = sheets.map((s, idx) => {
    const cleanName = escapeXml(String(s.name || `Sheet${idx + 1}`).replace(/[\[\]\*\?\/\\:]/g, ' ').slice(0, 31));
    return `<sheet name="${cleanName}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`;
  }).join('\n    ');

  files.push({
    name: 'xl/workbook.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${wbSheets}
  </sheets>
</workbook>`
  });

  // 5. xl/styles.xml
  files.push({
    name: 'xl/styles.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="#,##0.00"/>
    <numFmt numFmtId="165" formatCode="0.00&quot;%&quot;"/>
  </numFmts>
  <fonts count="4">
    <font><sz val="10"/><color rgb="FF1E293B"/><name val="Calibri"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
    <font><b/><sz val="10"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E3A8A"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="8">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="3" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/>
  </cellXfs>
</styleSheet>`
  });

  // 6. Worksheets
  sheets.forEach((sheet, idx) => {
    const cols = sheet.columns || [];
    const colXml = cols.length > 0
      ? `<cols>${cols.map((c, cIdx) => `<col min="${cIdx + 1}" max="${cIdx + 1}" width="${c.width || 18}" customWidth="1"/>`).join('')}</cols>`
      : '';

    const rowsXml = [];
    let currentRowNum = 1;

    // Optional preamble rows (metadata, summary key-values)
    if (Array.isArray(sheet.preamble)) {
      for (const pRow of sheet.preamble) {
        const cellsXml = [];
        pRow.forEach((cellObj, cIdx) => {
          const ref = `${colIndexToLetter(cIdx)}${currentRowNum}`;
          if (cellObj === null || cellObj === undefined) return;
          const val = typeof cellObj === 'object' && cellObj !== null && 'value' in cellObj ? cellObj.value : cellObj;
          const styleIdx = (typeof cellObj === 'object' && cellObj !== null && cellObj.styleId !== undefined) ? cellObj.styleId : (cIdx === 0 ? 7 : 0);
          const cellType = (typeof cellObj === 'object' && cellObj !== null && cellObj.type) ? cellObj.type : 'text';

          if (cellType === 'number' || cellType === 'currency' || cellType === 'integer' || cellType === 'percent') {
            const num = Number(val);
            if (Number.isFinite(num) && val !== '' && val !== null && val !== undefined) {
              const sId = cellType === 'currency' ? 3 : cellType === 'integer' ? 4 : cellType === 'percent' ? 5 : styleIdx;
              cellsXml.push(`<c r="${ref}" s="${sId}"><v>${num}</v></c>`);
              return;
            }
          }
          const safeStr = escapeXml(sanitizeFormulaText(val ?? ''));
          cellsXml.push(`<c r="${ref}" s="${styleIdx}" t="inlineStr"><is><t xml:space="preserve">${safeStr}</t></is></c>`);
        });
        rowsXml.push(`<row r="${currentRowNum}">${cellsXml.join('')}</row>`);
        currentRowNum++;
      }
    }

    // Table header row
    if (cols.length > 0) {
      const headerCells = cols.map((col, cIdx) => {
        const ref = `${colIndexToLetter(cIdx)}${currentRowNum}`;
        return `<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(col.header)}</t></is></c>`;
      });
      rowsXml.push(`<row r="${currentRowNum}">${headerCells.join('')}</row>`);
      currentRowNum++;
    }

    // Data rows
    for (const row of (sheet.rows || [])) {
      const cellsXml = [];
      cols.forEach((col, cIdx) => {
        const ref = `${colIndexToLetter(cIdx)}${currentRowNum}`;
        const rawVal = Array.isArray(row) ? row[cIdx] : row[col.key];
        const isTotalRow = !Array.isArray(row) && row._isTotalRow;

        if (rawVal === null || rawVal === undefined || rawVal === '') {
          const sId = isTotalRow ? 7 : 0;
          cellsXml.push(`<c r="${ref}" s="${sId}" t="inlineStr"><is><t></t></is></c>`);
          return;
        }

        const cType = col.type || 'text';
        if (cType === 'text' || cType === 'id' || cType === 'phone') {
          // Always force text cell to preserve phone numbers and long Meta IDs without scientific notation
          const safeText = escapeXml(sanitizeFormulaText(String(rawVal)));
          const sId = isTotalRow ? 7 : 6;
          cellsXml.push(`<c r="${ref}" s="${sId}" t="inlineStr"><is><t xml:space="preserve">${safeText}</t></is></c>`);
        } else if (cType === 'currency' || cType === 'number' || cType === 'integer' || cType === 'percent') {
          const num = Number(rawVal);
          if (Number.isFinite(num) && typeof rawVal !== 'boolean' && String(rawVal).trim() !== '') {
            const sId = isTotalRow ? 7 : (cType === 'currency' ? 3 : cType === 'integer' ? 4 : cType === 'percent' ? 5 : 0);
            cellsXml.push(`<c r="${ref}" s="${sId}"><v>${num}</v></c>`);
          } else {
            // e.g., "— / No leads" or "Unavailable"
            const safeText = escapeXml(sanitizeFormulaText(String(rawVal)));
            const sId = isTotalRow ? 7 : 0;
            cellsXml.push(`<c r="${ref}" s="${sId}" t="inlineStr"><is><t xml:space="preserve">${safeText}</t></is></c>`);
          }
        } else {
          const safeText = escapeXml(sanitizeFormulaText(String(rawVal)));
          const sId = isTotalRow ? 7 : 0;
          cellsXml.push(`<c r="${ref}" s="${sId}" t="inlineStr"><is><t xml:space="preserve">${safeText}</t></is></c>`);
        }
      });
      rowsXml.push(`<row r="${currentRowNum}">${cellsXml.join('')}</row>`);
      currentRowNum++;
    }

    files.push({
      name: `xl/worksheets/sheet${idx + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${colXml}
  <sheetData>
    ${rowsXml.join('\n    ')}
  </sheetData>
</worksheet>`
    });
  });

  return createZipBuffer(files);
}

/**
 * Decode XML entities
 */
function unescapeXml(str) {
  return String(str ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function letterToColIndex(letters) {
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col - 1;
}

/**
 * Parse an uploaded .xlsx buffer into sheets -> rows (2D array of strings/values)
 */
function parseXlsxBuffer(buffer) {
  const entries = readZipBuffer(buffer);

  // Read sharedStrings.xml if present
  const sharedStrings = [];
  if (entries['xl/sharedStrings.xml']) {
    const ssXml = entries['xl/sharedStrings.xml'].toString('utf8');
    const siMatches = ssXml.match(/<si[\s>][\s\S]*?<\/si>/g) || [];
    for (const si of siMatches) {
      const tMatches = si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || [];
      const text = tMatches.map(t => {
        const inner = t.replace(/^<t(?:\s[^>]*)?>/, '').replace(/<\/t>$/, '');
        return unescapeXml(inner);
      }).join('');
      sharedStrings.push(text);
    }
  }

  // Read workbook.xml for sheet names
  const sheetNames = [];
  if (entries['xl/workbook.xml']) {
    const wbXml = entries['xl/workbook.xml'].toString('utf8');
    const sheetTags = wbXml.match(/<sheet\s+[^>]*\/?>/g) || [];
    for (const tag of sheetTags) {
      const nameMatch = tag.match(/name="([^"]+)"/);
      if (nameMatch) sheetNames.push(unescapeXml(nameMatch[1]));
    }
  }

  const parsedSheets = [];
  const sheetKeys = Object.keys(entries)
    .filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = parseInt(a.match(/sheet(\d+)\.xml/)[1], 10);
      const nb = parseInt(b.match(/sheet(\d+)\.xml/)[1], 10);
      return na - nb;
    });

  sheetKeys.forEach((key, idx) => {
    const xml = entries[key].toString('utf8');
    const rows = [];
    const rowMatches = xml.match(/<row[\s>][\s\S]*?<\/row>/g) || [];

    for (const rowXml of rowMatches) {
      const rowArr = [];
      const cellMatches = rowXml.match(/<c\s+[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [];
      let nextColIdx = 0;

      for (const cellXml of cellMatches) {
        const refMatch = cellXml.match(/\br="([A-Z]+)\d+"/);
        const colIdx = refMatch ? letterToColIndex(refMatch[1]) : nextColIdx;
        while (rowArr.length < colIdx) rowArr.push('');

        const typeMatch = cellXml.match(/\bt="([^"]+)"/);
        const cellType = typeMatch ? typeMatch[1] : '';

        let val = '';
        if (cellType === 'inlineStr') {
          const tMatch = cellXml.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
          val = tMatch ? unescapeXml(tMatch[1]) : '';
        } else if (cellType === 's') {
          const vMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/);
          const sIdx = vMatch ? parseInt(vMatch[1], 10) : -1;
          val = (sIdx >= 0 && sIdx < sharedStrings.length) ? sharedStrings[sIdx] : '';
        } else {
          const vMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/);
          val = vMatch ? unescapeXml(vMatch[1]) : '';
        }

        rowArr[colIdx] = val;
        nextColIdx = colIdx + 1;
      }
      if (rowArr.some(c => String(c).trim() !== '')) {
        rows.push(rowArr);
      }
    }

    parsedSheets.push({
      name: sheetNames[idx] || `Sheet${idx + 1}`,
      rows
    });
  });

  return parsedSheets;
}

/**
 * Parse RFC-4180 CSV text (handles BOM, quoted fields, commas, newlines inside quotes, and TSV fallback)
 */
function parseCsvText(csvText) {
  const cleanText = String(csvText || '').replace(/^\uFEFF/, '');
  // Detect delimiter from first line
  const firstLineEnd = cleanText.indexOf('\n');
  const firstLine = firstLineEnd !== -1 ? cleanText.slice(0, firstLineEnd) : cleanText;
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delim = tabCount > commaCount ? '\t' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    const next = cleanText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        row.push(field.trim());
        field = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(field.trim());
        if (row.some(cell => cell !== '')) rows.push(row);
        row = [];
        field = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field.trim());
        if (row.some(cell => cell !== '')) rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    if (row.some(cell => cell !== '')) rows.push(row);
  }

  return rows;
}

module.exports = {
  createZipBuffer,
  buildXlsxBuffer,
  parseXlsxBuffer,
  parseCsvText,
  sanitizeFormulaText
};
