/** The JanusAPI mark (logo 4e): two braces facing out, one request and its answer, with the gate between them. */
export function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" fill="none" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path className="brace" d="M22 10 C14 10 16 22 16 26 C16 30 9 32 9 32 C9 32 16 34 16 38 C16 42 14 54 22 54" />
      <path className="brace" d="M42 10 C50 10 48 22 48 26 C48 30 55 32 55 32 C55 32 48 34 48 38 C48 42 50 54 42 54" />
      <line className="gate" x1="32" y1="12" x2="32" y2="52" />
    </svg>
  );
}

/** The wordmark: "Janus" in the text colour, "API" in mint. Reads as one word, JanusAPI. */
export function Wordmark() {
  return <span>Janus<span className="brand-accent">API</span></span>;
}
