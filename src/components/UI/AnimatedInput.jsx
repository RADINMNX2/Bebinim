import React, { useEffect, useRef } from 'react';

// Bidi-safe text segmentation: split the value into directionally consistent
// runs (RTL script / LTR script / neutral) so per-character animated spans
// never break the browser's bidi algorithm (atomic inline-blocks otherwise
// reorder and reverse English text inside an RTL field).
const NEUTRAL_RE = /[\s,.;:!؟?،؛()\[\]{}"'`~\-_=+/\\*|<>@#%^&$…]/u;
const RTL_RE = /[\u0591-\u07FF\u200F\uFB1D-\uFDFD\uFE70-\uFEFC]/u;

const classifyChar = (ch) => {
  if (NEUTRAL_RE.test(ch)) return null;
  if (/\d/.test(ch)) return 'ltr'; // ASCII digits keep LTR order inside RTL runs
  return RTL_RE.test(ch) ? 'rtl' : 'ltr';
};

const buildSegments = (value) => {
  const chars = Array.from(value);
  const segments = [];
  let current = [];
  let type = null;
  const flush = () => {
    if (current.length) {
      segments.push({ chars: current, type });
      current = [];
      type = null;
    }
  };
  for (const ch of chars) {
    const t = classifyChar(ch);
    if (t === null) {
      current.push(ch); // neutrals attach to the surrounding run
    } else if (type === null || t === type) {
      current.push(ch);
      type = t;
    } else {
      flush();
      current = [ch];
      type = t;
    }
  }
  flush();
  return segments;
};

// Modern neon input with a per-character typing animation.
// A transparent native <input> keeps full keyboard behavior (caret,
// selection, IME, form submit); an overlay mirrors the text as animated
// spans, scrolled in lockstep so caret and letters never desync.
export const AnimatedInput = ({
  value,
  onChange,
  placeholder = '',
  type = 'text',
  maxLength,
  autoFocus,
  dir = 'rtl',
  wrapperClassName = '',
  fieldClassName = '',
}) => {
  const nativeRef = useRef(null);
  const textRef = useRef(null);

  // Keep the animated text aligned with the (invisible) native caret
  // when the field scrolls internally.
  const syncScroll = () => {
    const native = nativeRef.current;
    const text = textRef.current;
    if (native && text) text.scrollLeft = native.scrollLeft;
  };

  useEffect(() => {
    syncScroll();
  }, [value]);

  const segments = buildSegments(value);
  let charIndex = 0;

  return (
    <div
      className={`modern-input ${wrapperClassName}`}
      onClick={() => nativeRef.current?.focus()}
    >
      <input
        ref={nativeRef}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        maxLength={maxLength}
        autoFocus={autoFocus}
        dir={dir}
        spellCheck={false}
        autoComplete="off"
        aria-label={placeholder}
        className={`mi-native ${fieldClassName}`}
        onScroll={syncScroll}
      />
      <div ref={textRef} dir={dir} aria-hidden="true" className={`mi-text ${fieldClassName}`}>
        {value === '' ? (
          <span className="mi-placeholder">{placeholder}</span>
        ) : (
          segments.map((seg, si) => (
            <span key={si} className="mi-seg" dir={seg.type || 'auto'}>
              {seg.chars.map((ch, i) => {
                const delay = Math.min(charIndex * 14, 140);
                charIndex += 1;
                return (
                  <span key={i} className="mi-char" style={{ animationDelay: `${delay}ms` }}>
                    {ch}
                  </span>
                );
              })}
            </span>
          ))
        )}
      </div>
    </div>
  );
};

export default AnimatedInput;