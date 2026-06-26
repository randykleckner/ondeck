export function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === "," && !quoted) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(field);
      if (row.some((value) => value.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value.trim() !== "")) {
      rows.push(row);
    }
  }

  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map((header) => normalizeHeader(header));
  return rows.slice(1).map((values) => {
    return headers.reduce((record, header, index) => {
      record[header] = coerceValue(values[index] ?? "");
      return record;
    }, {});
  });
}

export function toCsv(records) {
  if (!records.length) {
    return "";
  }

  const headers = Object.keys(records[0]);
  const lines = [headers.join(",")];
  for (const record of records) {
    lines.push(headers.map((header) => escapeCsv(record[header])).join(","));
  }
  return lines.join("\n");
}

function normalizeHeader(value) {
  return String(value).trim().toLowerCase().replaceAll(/\s+/g, "_");
}

function coerceValue(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") {
    return "";
  }
  if (trimmed.toLowerCase() === "true") {
    return true;
  }
  if (trimmed.toLowerCase() === "false") {
    return false;
  }
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric) && trimmed.match(/^-?\d*\.?\d+$/)) {
    return numeric;
  }
  return trimmed;
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}
