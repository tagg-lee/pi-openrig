// Minimal Server-Sent Events parser for the OpenRig daemon stream (/api/events).
// Feed it decoded text chunks; it returns complete events and keeps the remainder.

export type SseEvent = { id?: string; data: string };

export function createSseParser() {
  let buf = "";
  return (chunk: string): SseEvent[] => {
    buf += chunk.replace(/\r\n/g, "\n");
    const out: SseEvent[] = [];
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) out.push({ id, data: data.join("\n") });
    }
    return out;
  };
}
