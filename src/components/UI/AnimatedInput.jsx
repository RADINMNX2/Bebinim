import React, { useEffect, useRef } from 'react';

// Modern neon input with a per-character typing animation.
// A transparent native <input> keeps full keyboard behavior (caret,
// selection, IME, form submit); an overlay mirrors the text as animated
// spans, scrolled in lockstep so caret and letters never desync.
//
// Characters are plain INLINE spans (never inline-block): atomic boxes
// split the text into separate shaping runs, which breaks both the
// browser's bidi algorithm (reversed English in RTL fields) and
// Arabic/Persian contextual joining (isolated, disconnected letters).
// Inline spans merge back into a single shaping run, so bidi and letter
// connections stay fully native.
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

  const chars = Array.from(value);

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
          chars.map((ch, i) => (
            <span key={`${i}-${ch}`} className="mi-char" style={{ animationDelay: `${Math.min(i * 14, 140)}ms` }}>
              {ch}
            </span>
          ))
        )}
      </div>
    </div>
  );
};

export default AnimatedInput;
