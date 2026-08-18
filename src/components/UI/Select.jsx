import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronDown, Check } from 'lucide-react';

// Modern neon dropdown matching AnimatedInput's look: a styled trigger that
// opens an animated, fully keyboard-navigable option list (WAI-ARIA combobox).
export const Select = ({
  value,
  options = [],
  onChange,
  label = '',
  placeholder = 'انتخاب کنید...',
  wrapperClassName = '',
}) => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef(null);

  const selected = options.find((o) => o.value === value) || null;

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  // Keyboard navigation: arrows move, Enter selects, Escape closes
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((prev) => {
          if (prev < 0) return dir > 0 ? 0 : options.length - 1;
          return (prev + dir + options.length) % options.length;
        });
      } else if (e.key === 'Enter' && activeIndex >= 0 && options[activeIndex]) {
        e.preventDefault();
        onChange(options[activeIndex].value);
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, activeIndex, options, onChange, close]);

  return (
    <div ref={rootRef} className={`modern-select ${wrapperClassName}`}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label || placeholder}
        onClick={() => setOpen((o) => !o)}
        className="ms-trigger"
      >
        <span className={`ms-value ${selected ? '' : 'ms-value-empty'}`}>
          {label && <span className="ms-label">{label}: </span>}
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className={`ms-arrow ${open ? 'ms-arrow-open' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <ul role="listbox" aria-label={label || placeholder} className="ms-menu">
          {options.map((opt, i) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              onClick={() => {
                onChange(opt.value);
                close();
              }}
              onMouseEnter={() => setActiveIndex(i)}
              style={{ animationDelay: `${i * 30}ms` }}
              className={`ms-option ${opt.value === value ? 'ms-option-selected' : ''} ${i === activeIndex ? 'ms-option-active' : ''}`}
            >
              <span>{opt.label}</span>
              {opt.value === value && <Check className="w-4 h-4" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default Select;
