import { useLayoutEffect, useRef, useState } from 'react';

// Gateway chat events are cumulative snapshots, batched at roughly 150 ms.
// Smooth only their presentation; the workspace always keeps the full message.
export function useStreamingText(text: string, streaming: boolean, onReveal: () => void) {
  const [shown, setShown] = useState(streaming ? '' : text);
  const shownRef = useRef(shown);

  useLayoutEffect(() => {
    const from = shownRef.current;
    if (!streaming || !text.startsWith(from)) {
      shownRef.current = text;
      setShown(text);
      return;
    }
    if (from === text) return;
    let frame: number;
    let started: number | undefined;
    const reveal = (now: number) => {
      started ??= now;
      const progress = Math.min(1, (now - started) / 120);
      let end = from.length + Math.ceil((text.length - from.length) * progress);
      // Never render half of a UTF-16 surrogate pair (e.g. an emoji).
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
      shownRef.current = text.slice(0, end);
      setShown(shownRef.current);
      if (progress < 1) frame = requestAnimationFrame(reveal);
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [text, streaming]);

  // Scrolling must follow the rendered frames, including the final buffered one.
  useLayoutEffect(onReveal, [shown, text, streaming, onReveal]);
  return streaming && text.startsWith(shown) ? shown : text;
}
