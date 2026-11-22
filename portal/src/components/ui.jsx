import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import { subscribeToast } from '../lib/api.js';

export function Button({
  variant = 'primary',
  size,
  block = false,
  loading = false,
  disabled = false,
  icon,
  trailingIcon,
  children,
  className = '',
  type = 'button',
  ...rest
}) {
  const isDisabled = Boolean(disabled || loading);
  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={`btn ${variant}${size ? ' ' + size : ''}${block ? ' btn-block' : ''}${loading ? ' is-loading' : ''} ${className}`.trim()}
      {...rest}
    >
      {loading && <span className="b2b-btn-spinner" aria-hidden="true" />}
      {!loading && icon && <Icon name={icon} />}
      {children != null && <span>{children}</span>}
      {trailingIcon && <Icon name={trailingIcon} />}
    </button>
  );
}

export function Section({ title, action, footer, children, className = '' }) {
  return (
    <section className={'sect ' + className}>
      {(title || action) && (
        <div className="sect-head-row">
          {title && <h2 className="sect-t">{title}</h2>}
          {action && <div className="sect-act">{action}</div>}
        </div>
      )}
      <div className="sect-b">{children}</div>
      {footer && <p className="sect-f">{footer}</p>}
    </section>
  );
}

export function Row({ icon, iconTint, title, subtitle, value, accessory = 'none', onClick, danger, children, className = '' }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={'lrow' + (onClick ? ' tap' : '') + (danger ? ' danger' : '') + ' ' + className}
      onClick={onClick}
    >
      {icon && <span className="lrow-i" style={iconTint ? { '--tint': iconTint } : null}><Icon name={icon} /></span>}
      <span className="lrow-m">
        <span className="lrow-t">{title}</span>
        {subtitle && <span className="lrow-s">{subtitle}</span>}
      </span>
      {children}
      {value != null && <span className="lrow-v">{value}</span>}
      {accessory === 'chevron' && <Icon name="chevronRight" className="lrow-c" />}
      {accessory === 'check' && <Icon name="check" className="lrow-k" />}
    </Tag>
  );
}

export function Segmented({ options, value, onChange, className = '' }) {
  return (
    <div className={'seg seg-scroll b2b-seg ' + className} role="tablist">
      {options.map(o => (
        <button
          type="button"
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} style={{ marginRight: 5 }} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      className={'sw' + (checked ? ' on' : '')}
      onClick={e => { e.stopPropagation(); if (!disabled) onChange?.(!checked); }}
    >
      <span className="knob" />
    </button>
  );
}

export function SearchField({ value, onChange, placeholder = 'Buscar...', className = '', autoFocus = false }) {
  return (
    <div className={'searchf b2b-searchf ' + className}>
      <Icon name="magnifier" className="lead" />
      <input
        type="search"
        className="field"
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {value && (
        <button type="button" className="clear" aria-label="Limpar busca" onClick={() => onChange('')}>
          <Icon name="xmark" />
        </button>
      )}
    </div>
  );
}

export function TextField({ label, hint, value, onChange, placeholder, type = 'text', required, disabled, className = '', id, ...rest }) {
  const autoId = useId();
  const fieldId = id || autoId;
  const [showPw, setShowPw] = useState(false);
  const isPw = type === 'password';
  const effectiveType = isPw ? (showPw ? 'text' : 'password') : type;

  return (
    <label className={'b2b-field ' + className} htmlFor={fieldId}>
      {label && <span className="b2b-field-lbl">{label}{required && <span className="b2b-req"> *</span>}</span>}
      {isPw ? (
        <div className="b2b-pw-wrap">
          <input
            id={fieldId}
            type={effectiveType}
            className="field"
            value={value ?? ''}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            required={required}
            disabled={disabled}
            {...rest}
          />
          <button
            type="button"
            className="b2b-pw-toggle"
            onClick={e => {
              e.preventDefault();
              setShowPw(v => !v);
            }}
            title={showPw ? 'Ocultar senha' : 'Mostrar senha'}
            aria-label={showPw ? 'Ocultar senha' : 'Mostrar senha'}
            aria-pressed={showPw}
          >
            <Icon name={showPw ? 'eyeSlash' : 'eye'} size={16} />
          </button>
        </div>
      ) : (
        <input
          id={fieldId}
          type={type}
          className="field"
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          {...rest}
        />
      )}
      {hint && <span className="b2b-field-hint">{hint}</span>}
    </label>
  );
}

export function NumberField({ label, hint, value, onChange, min, max, step = 1, suffix, className = '', ...rest }) {
  return (
    <label className={'b2b-field ' + className}>
      {label && <span className="b2b-field-lbl">{label}</span>}
      <div className="b2b-num-wrap">
        <input
          type="number"
          inputMode="decimal"
          className="field num"
          value={value ?? ''}
          min={min}
          max={max}
          step={step}
          onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          {...rest}
        />
        {suffix && <span className="b2b-num-suf">{suffix}</span>}
      </div>
      {hint && <span className="b2b-field-hint">{hint}</span>}
    </label>
  );
}

export function TextArea({ label, hint, value, onChange, placeholder, rows = 3, className = '' }) {
  return (
    <label className={'b2b-field ' + className}>
      {label && <span className="b2b-field-lbl">{label}</span>}
      <textarea
        className="field area"
        rows={rows}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {hint && <span className="b2b-field-hint">{hint}</span>}
    </label>
  );
}

export function SelectField({ label, hint, value, onChange, options = [], className = '' }) {
  return (
    <label className={'b2b-field ' + className}>
      {label && <span className="b2b-field-lbl">{label}</span>}
      <select className="adm-select b2b-select" value={value ?? ''} onChange={e => onChange(e.target.value)}>
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {hint && <span className="b2b-field-hint">{hint}</span>}
    </label>
  );
}

export function Stepper({ value, onChange, step = 1, min = 0, max = 999, format }) {
  const dec = () => onChange(Math.max(min, Number(value || 0) - step));
  const inc = () => onChange(Math.min(max, Number(value || 0) + step));
  return (
    <div className="stp">
      <button type="button" onClick={dec} disabled={value <= min} aria-label="Diminuir"><Icon name="minus" /></button>
      <span className="stp-v">{format ? format(value) : value}</span>
      <button type="button" onClick={inc} disabled={value >= max} aria-label="Aumentar"><Icon name="plus" /></button>
    </div>
  );
}

export function ChipBar({ items, value, onChange, className = '' }) {
  return (
    <div className={'chips wrap b2b-chips ' + className}>
      {items.map(it => (
        <button
          type="button"
          key={it.value}
          className={'chip ichip nocap' + (value === it.value ? ' on' : '')}
          onClick={() => onChange(it.value)}
        >
          {it.icon && <Icon name={it.icon} size={15} />}
          <span>{it.label}</span>
          {it.count !== undefined && <span className="b2b-chip-cnt">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function StatusPill({ tone = 'muted', icon, children, className = '' }) {
  const cls = tone === 'ok' || tone === 'active'
    ? 'adm-pill ok'
    : tone === 'accent' || tone === 'acc'
      ? 'adm-pill acc'
      : tone === 'warn' || tone === 'trial' || tone === 'warning'
        ? 'adm-pill warn'
        : tone === 'bad' || tone === 'danger' || tone === 'suspended' || tone === 'past_due' || tone === 'critical'
          ? 'adm-pill bad'
          : 'adm-pill';
  return (
    <span className={(cls + ' ' + className).trim()}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

export function KpiTile({ label, value, sub, icon, tint = 'var(--acc)', onClick, trend }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={'tile b2b-kpi' + (onClick ? ' tap' : '')}
      onClick={onClick}
    >
      <div className="b2b-kpi-top">
        <span className="t-lbl">{label}</span>
        {icon && (
          <span className="b2b-kpi-ico" style={{ '--tint': tint }}>
            <Icon name={icon} size={17} />
          </span>
        )}
      </div>
      <div className="t-val num">{value}</div>
      {(sub || trend) && (
        <div className="t-sub">
          {trend && <span className={'b2b-trend ' + (trend.positive ? 'up' : 'down')}>{trend.text}</span>}
          {sub && <span>{sub}</span>}
        </div>
      )}
    </Tag>
  );
}

export function CardHead({ icon, iconTint, title, subtitle, action }) {
  return (
    <div className="chead b2b-chead">
      <div className="b2b-chead-l">
        {icon && (
          <span className="lrow-i" style={iconTint ? { '--tint': iconTint } : null}>
            <Icon name={icon} />
          </span>
        )}
        <div>
          <h3 className="b2b-card-title">{title}</h3>
          {subtitle && <div className="muted small">{subtitle}</div>}
        </div>
      </div>
      {action && <div className="b2b-chead-r">{action}</div>}
    </div>
  );
}

export function EmptyState({ icon = 'clipboard', title, message, action }) {
  return (
    <div className="empty b2b-empty">
      <div className="empty-i"><Icon name={icon} size={28} /></div>
      {title && <div className="empty-t">{title}</div>}
      {message && <div className="empty-s">{message}</div>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

const activeModalStack = [];
const MODAL_FOCUSABLE_SELECTOR = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, subtitle, size = 'md', zIndex, children, footer }) {
  const [depth, setDepth] = useState(0);
  const titleId = useId();
  const modalRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const modalId = Math.random().toString(36).slice(2);
    activeModalStack.push(modalId);
    setDepth(Math.max(0, activeModalStack.length - 1));

    const prevFocus = typeof document !== 'undefined' ? document.activeElement : null;

    // Bloqueia scroll do fundo enquanto houver ao menos 1 modal aberto
    if (activeModalStack.length === 1 && typeof document !== 'undefined') {
      document.body.style.overflow = 'hidden';
    }

    const rafId = requestAnimationFrame(() => {
      const box = modalRef.current;
      if (!box || box.contains(document.activeElement)) return;
      const first = box.querySelector(MODAL_FOCUSABLE_SELECTOR);
      if (first && typeof first.focus === 'function') first.focus();
      else box.focus();
    });

    const onKey = e => {
      if (activeModalStack[activeModalStack.length - 1] !== modalId) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current?.();
      } else if (e.key === 'Tab') {
        const box = modalRef.current;
        if (!box) return;
        const focusables = Array.from(box.querySelectorAll(MODAL_FOCUSABLE_SELECTOR))
          .filter(el => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) {
          e.preventDefault();
          box.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !box.contains(document.activeElement) || document.activeElement === box) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last || !box.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKey);
      const idx = activeModalStack.indexOf(modalId);
      if (idx !== -1) activeModalStack.splice(idx, 1);
      if (activeModalStack.length === 0 && typeof document !== 'undefined') {
        document.body.style.overflow = '';
      }
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
        prevFocus.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const computedZ = zIndex !== undefined ? zIndex : 500 + depth * 60;

  const modalNode = (
    <div
      className="b2b-modal-backdrop"
      data-depth={depth}
      style={{ zIndex: computedZ }}
      onClick={() => onCloseRef.current?.()}
    >
      <div
        ref={modalRef}
        className={`b2b-modal b2b-modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="b2b-modal-head">
          <div>
            <h3 id={titleId}>{title}</h3>
            {subtitle && <p className="muted small" style={{ margin: '2px 0 0' }}>{subtitle}</p>}
          </div>
          <button type="button" className="b2b-icon-btn" onClick={() => onCloseRef.current?.()} aria-label="Fechar">
            <Icon name="xmark" size={18} />
          </button>
        </div>
        <div className="b2b-modal-body">{children}</div>
        {footer && <div className="b2b-modal-foot">{footer}</div>}
      </div>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(modalNode, document.body);
  }
  return modalNode;
}

export function LoadingState({ label = 'Carregando...', cards = 4 }) {
  return (
    <div className="b2b-loading-state" role="status" aria-live="polite">
      {cards > 0 && (
        <div className="b2b-kpi-grid" aria-hidden="true">
          {Array.from({ length: cards }).map((_, i) => (
            <div key={i} className="b2b-skeleton-card">
              <div className="b2b-skeleton b2b-skeleton-line sm" />
              <div className="b2b-skeleton b2b-skeleton-line lg" />
              <div className="b2b-skeleton b2b-skeleton-line md" />
            </div>
          ))}
        </div>
      )}
      <div className="card b2b-skeleton-panel">
        <div className="b2b-loading-label">
          <span className="b2b-btn-spinner" aria-hidden="true" />
          <span>{label}</span>
        </div>
        <div className="b2b-skeleton b2b-skeleton-line full" aria-hidden="true" />
        <div className="b2b-skeleton b2b-skeleton-line md" aria-hidden="true" />
      </div>
    </div>
  );
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title = 'Confirmar ação',
  subtitle,
  message,
  confirmLabel = 'Confirmar',
  confirmVariant = 'danger',
  confirmIcon = 'check',
  loading = false,
  zIndex = 750
}) {
  return (
    <Modal
      open={open}
      onClose={loading ? undefined : onClose}
      size="sm"
      zIndex={zIndex}
      title={title}
      subtitle={subtitle}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button
            variant={confirmVariant}
            icon={confirmIcon}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? 'Processando...' : confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ lineHeight: 1.5, fontSize: 14 }}>
        {message}
      </div>
    </Modal>
  );
}

export function ActionMenu({
  items = [],
  label = 'Ações',
  buttonLabel = 'Ações',
  icon = 'menu',
  align = 'right',
  disabled = false,
  className = ''
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();
  const visibleItems = items.filter(Boolean);

  const computePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuEl = menuRef.current;
    const menuWidth = menuEl ? menuEl.offsetWidth : 236;
    const menuHeight = menuEl ? menuEl.offsetHeight : Math.min(340, visibleItems.length * 46 + 18);
    const pad = 12;
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = align === 'left' ? rect.left : rect.right - menuWidth;
    left = Math.max(pad, Math.min(left, vw - menuWidth - pad));

    const spaceBelow = vh - rect.bottom - pad;
    const spaceAbove = rect.top - pad;
    const openUp = spaceBelow < menuHeight + gap && spaceAbove > spaceBelow;
    let top = openUp ? rect.top - menuHeight - gap : rect.bottom + gap;
    top = Math.max(pad, Math.min(top, vh - menuHeight - pad));

    setCoords({ top: Math.round(top), left: Math.round(left), openUp });
  };

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    computePosition();
  }, [open, visibleItems.length]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = e => {
      if (triggerRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKeyDown = e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScroll = e => {
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  if (visibleItems.length === 0) return null;

  return (
    <div className={`b2b-action-menu ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn ghost sm b2b-action-menu-trigger${open ? ' is-open' : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={label}
        disabled={disabled}
        onClick={e => {
          e.stopPropagation();
          setOpen(prev => !prev);
        }}
      >
        <Icon name={icon} />
        {buttonLabel && <span className="b2b-action-menu-trigger-label">{buttonLabel}</span>}
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className={`b2b-action-menu-popover${coords?.openUp ? ' is-up' : ''}`}
            style={{
              top: coords ? `${coords.top}px` : '-9999px',
              left: coords ? `${coords.left}px` : '-9999px',
              visibility: coords ? 'visible' : 'hidden'
            }}
            onClick={e => e.stopPropagation()}
          >
            {visibleItems.map((item, idx) => (
              <React.Fragment key={item.key || `${item.label}-${idx}`}>
                {item.dividerBefore && idx > 0 && <div className="b2b-action-menu-divider" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={Boolean(item.disabled)}
                  className={`b2b-action-menu-item${item.tone ? ` is-${item.tone}` : ''}`}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect?.();
                  }}
                >
                  {item.icon && <Icon name={item.icon} />}
                  <span>{item.label}</span>
                </button>
              </React.Fragment>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}

export function ToastHost() {
  const [msg, setMsg] = useState('');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer = null;
    return subscribeToast(text => {
      setMsg(text);
      setVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), 3200);
    });
  }, []);

  return (
    <div id="toast" className={`b2b-toast ${visible ? 'show on' : ''}`} role="status" aria-live="polite">
      {msg}
    </div>
  );
}
