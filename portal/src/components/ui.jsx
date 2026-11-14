import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { subscribeToast } from '../lib/api.js';

export function Button({ variant = 'primary', size, block = false, icon, trailingIcon, children, className = '', type = 'button', ...rest }) {
  return (
    <button
      type={type}
      className={`btn ${variant}${size ? ' ' + size : ''}${block ? ' btn-block' : ''} ${className}`.trim()}
      {...rest}
    >
      {icon && <Icon name={icon} />}
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

export function TextField({ label, hint, value, onChange, placeholder, type = 'text', required, disabled, className = '', ...rest }) {
  const [showPw, setShowPw] = useState(false);
  const isPw = type === 'password';
  const effectiveType = isPw ? (showPw ? 'text' : 'password') : type;

  return (
    <label className={'b2b-field ' + className}>
      {label && <span className="b2b-field-lbl">{label}{required && <span className="b2b-req"> *</span>}</span>}
      {isPw ? (
        <div className="b2b-pw-wrap">
          <input
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
            tabIndex={-1}
            title={showPw ? 'Ocultar senha' : 'Mostrar senha'}
            aria-label={showPw ? 'Ocultar senha' : 'Mostrar senha'}
          >
            <Icon name={showPw ? 'eyeSlash' : 'eye'} size={16} />
          </button>
        </div>
      ) : (
        <input
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
    : tone === 'warn' || tone === 'trial' || tone === 'warning'
      ? 'adm-pill warn'
      : tone === 'bad' || tone === 'danger' || tone === 'suspended' || tone === 'past_due' || tone === 'critical'
        ? 'adm-pill bad'
        : 'adm-pill';
  return (
    <span className={(cls + ' ' + className).trim()}>
      {icon && <Icon name={icon} size={13} />}
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

export function Modal({ open, onClose, title, subtitle, size = 'md', zIndex, children, footer }) {
  const [depth, setDepth] = useState(0);

  useEffect(() => {
    if (!open) return;
    const modalId = Math.random().toString(36).slice(2);
    activeModalStack.push(modalId);
    setDepth(Math.max(0, activeModalStack.length - 1));

    // Bloqueia scroll do fundo enquanto houver ao menos 1 modal aberto
    if (activeModalStack.length === 1 && typeof document !== 'undefined') {
      document.body.style.overflow = 'hidden';
    }

    const onKey = e => {
      if (e.key === 'Escape') {
        // Apenas o modal mais ao topo da pilha responde ao Escape
        if (activeModalStack[activeModalStack.length - 1] === modalId) {
          e.stopPropagation();
          onClose?.();
        }
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      const idx = activeModalStack.indexOf(modalId);
      if (idx !== -1) activeModalStack.splice(idx, 1);
      if (activeModalStack.length === 0 && typeof document !== 'undefined') {
        document.body.style.overflow = '';
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  const computedZ = zIndex !== undefined ? zIndex : 500 + depth * 60;

  return (
    <div
      className="b2b-modal-backdrop"
      data-depth={depth}
      style={{ zIndex: computedZ }}
      onClick={onClose}
    >
      <div
        className={`b2b-modal b2b-modal-${size}`}
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
      >
        <div className="b2b-modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p className="muted small" style={{ margin: '2px 0 0' }}>{subtitle}</p>}
          </div>
          <button type="button" className="b2b-icon-btn" onClick={onClose} aria-label="Fechar">
            <Icon name="xmark" size={18} />
          </button>
        </div>
        <div className="b2b-modal-body">{children}</div>
        {footer && <div className="b2b-modal-foot">{footer}</div>}
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
