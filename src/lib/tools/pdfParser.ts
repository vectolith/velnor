import zlib from "zlib";

/**
 * Extracts readable text from a PDF buffer or base64 data URL without external native dependencies.
 * Parses both uncompressed PDF text blocks (BT ... ET, Tj, TJ) and FlateDecode compressed streams.
 */
export function extractTextFromPdfBuffer(buffer: Buffer): string {
  const rawLatin1 = buffer.toString("latin1");
  const extractedParts: string[] = [];

  function decodePdfStringLiteral(str: string): string {
    return str
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\")
      .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
  }

  function parseTextOperators(streamText: string) {
    // Match (text) Tj
    const tjRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
    let match: RegExpExecArray | null;
    while ((match = tjRegex.exec(streamText)) !== null) {
      const cleaned = decodePdfStringLiteral(match[1]).trim();
      if (cleaned) extractedParts.push(cleaned);
    }

    // Match [(text) -20 (more)] TJ
    const tjArrayRegex = /\[([\s\S]*?)\]\s*TJ/g;
    while ((match = tjArrayRegex.exec(streamText)) !== null) {
      const inner = match[1];
      const strRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
      let innerMatch: RegExpExecArray | null;
      const linePieces: string[] = [];
      while ((innerMatch = strRegex.exec(inner)) !== null) {
        linePieces.push(decodePdfStringLiteral(innerMatch[1]));
      }
      if (linePieces.length > 0) {
        extractedParts.push(linePieces.join(""));
      }
    }
  }

  // 1. Parse uncompressed text operators
  parseTextOperators(rawLatin1);

  // 2. Decompress FlateDecode streams and parse text operators inside them
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let streamMatch: RegExpExecArray | null;
  while ((streamMatch = streamRegex.exec(rawLatin1)) !== null) {
    try {
      const streamBytes = Buffer.from(streamMatch[1], "latin1");
      const inflated = zlib.inflateSync(streamBytes).toString("latin1");
      parseTextOperators(inflated);
    } catch {
      // Not a raw zlib stream or uses different predictor; ignore
    }
  }

  const combined = extractedParts
    .join(" ")
    .replace(/[^\x20-\x7E\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (combined.length > 20) {
    return combined.slice(0, 35000);
  }

  // Fallback: extract printable ASCII runs >= 6 chars outside binary headers
  const asciiRuns = rawLatin1.match(/[A-Za-z0-9 ,.;:'"?!()-]{12,}/g) || [];
  const filtered = asciiRuns.filter(
    (s) =>
      !s.includes("/Type") &&
      !s.includes("/Font") &&
      !s.includes("endobj") &&
      !s.includes("FlateDecode")
  );
  return filtered.join(" ").slice(0, 25000) || "PDF document uploaded.";
}
