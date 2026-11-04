// Renders an edit form from a slide type's JSON schema (generated from its Zod
// config). New slide types get a working form without admin code changes.
import { lazy, Suspense, useEffect, useState } from 'react';
import type { Ecc } from '@foyer/qr-art';
import { api, type JsonSchemaProperty, type Option, type User } from './api.ts';
import { MediaField } from './Media.tsx';
import type { QrArtValue } from './QrArtField.tsx';

// Loaded on demand: it brings the QR solver and decoder along.
const QrArtField = lazy(() => import('./QrArtField.tsx').then((m) => ({ default: m.QrArtField })));

interface Props {
  schema: { properties: Record<string, JsonSchemaProperty> };
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
  /** Needed by media fields (picker with upload). */
  user?: User;
  onError?: (e: unknown) => void;
  /** Slide type id; option lists (widget "options") are loaded from its server. */
  typeId?: string;
}

function kind(prop: JsonSchemaProperty): string {
  if (prop.enum) return 'enum';
  if (prop.anyOf) return prop.anyOf.find((p) => p.type)?.type ?? 'string';
  return prop.type ?? 'string';
}

export function defaultsFor(schema: Props['schema']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) out[name] = prop.default;
  }
  return out;
}

export function SchemaForm({ schema, value, onChange, disabled, user, onError = () => undefined, typeId }: Props) {
  const set = (name: string, v: unknown) => onChange({ ...value, [name]: v });
  return (
    <div className="form">
      {Object.entries(schema.properties ?? {}).map(([name, prop]) => {
        const label = prop.description ?? name;
        const current = value[name] ?? prop.default ?? '';
        const id = `field-${name}`;
        if (prop.widget === 'qr-art') {
          return (
            <div key={name} className="field">
              <span>{label}</span>
              <Suspense fallback={<p className="muted">QR-Editor wird geladen …</p>}>
                <QrArtField
                  value={{ ...(prop.default as QrArtValue), ...(current as Partial<QrArtValue>) }}
                  url={typeof value.qrUrl === 'string' ? value.qrUrl : ''}
                  ecc={(value.qrEcc as Ecc | undefined) ?? 'M'}
                  disabled={disabled}
                  onChange={(v) => set(name, v)}
                />
              </Suspense>
            </div>
          );
        }
        if (prop.widget === 'options' && prop.options && typeId) {
          return (
            <div key={name} className="field">
              <span>{label}</span>
              <OptionsField
                typeId={typeId}
                list={prop.options}
                config={value}
                field={name}
                value={Array.isArray(current) ? (current as string[]) : []}
                disabled={disabled}
                onChange={(v) => set(name, v)}
              />
            </div>
          );
        }
        switch (kind(prop)) {
          case 'boolean':
            return (
              <label key={name} className="field field--check">
                <input id={id} type="checkbox" checked={Boolean(current)} disabled={disabled} onChange={(e) => set(name, e.target.checked)} />
                {label}
              </label>
            );
          case 'enum':
            return (
              <label key={name} className="field">
                <span>{label}</span>
                <select id={id} value={String(current)} disabled={disabled} onChange={(e) => set(name, e.target.value)}>
                  {prop.enum!.map((option) => (
                    <option key={option} value={option}>{prop.labels?.[option] ?? option}</option>
                  ))}
                </select>
              </label>
            );
          case 'number':
          case 'integer':
            return (
              <label key={name} className="field">
                <span>{label}</span>
                <input id={id} type="number" value={String(current)} disabled={disabled} onChange={(e) => set(name, e.target.value === '' ? undefined : Number(e.target.value))} />
              </label>
            );
          default:
            if (prop.widget === 'media' && user) {
              return (
                <div key={name} className="field">
                  <span>{label}</span>
                  <MediaField
                    kind={prop.accept ?? 'image'}
                    value={typeof current === 'string' && current ? current : null}
                    user={user}
                    disabled={disabled}
                    onError={onError}
                    onChange={(id) => set(name, id ?? '')}
                  />
                </div>
              );
            }
            if (prop.widget === 'textarea' || prop.widget === 'code') {
              return (
                <label key={name} className="field">
                  <span>{label}</span>
                  <textarea
                    id={id}
                    className={prop.widget === 'code' ? 'code' : undefined}
                    rows={prop.widget === 'code' ? 10 : 4}
                    spellCheck={prop.widget !== 'code'}
                    value={String(current)}
                    maxLength={prop.maxLength}
                    disabled={disabled}
                    onChange={(e) => set(name, e.target.value)}
                  />
                </label>
              );
            }
            return (
              <label key={name} className="field">
                <span>{label}</span>
                <input id={id} type="text" value={String(current)} maxLength={prop.maxLength} disabled={disabled} onChange={(e) => set(name, e.target.value)} />
              </label>
            );
        }
      })}
    </div>
  );
}

interface OptionsFieldProps {
  typeId: string;
  list: string;
  config: Record<string, unknown>;
  field: string;
  value: string[];
  disabled?: boolean;
  onChange: (value: string[]) => void;
}

/**
 * Multiple choice from a server option list (e.g. the rooms of the Untis export).
 * The list depends on the other config fields (e.g. the source URL), so it is
 * reloaded when they change. Chosen values the list no longer has stay chosen.
 */
function OptionsField({ typeId, list, config, field, value, disabled, onChange }: OptionsFieldProps) {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const { [field]: _own, ...rest } = config;
  const dependsOn = JSON.stringify(rest);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .get<Option[]>(`/slide-types/${encodeURIComponent(typeId)}/options/${encodeURIComponent(list)}?config=${encodeURIComponent(dependsOn)}`)
        .then((result) => {
          if (cancelled) return;
          setOptions(result);
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setOptions(null);
          setError((e as Error).message);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [typeId, list, dependsOn]);

  const known = new Set((options ?? []).map((o) => o.value));
  const all = [...(options ?? []), ...value.filter((v) => !known.has(v)).map((v) => ({ value: v, label: `${v} (nicht in der Datenquelle)` }))];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? all.filter((o) => o.label.toLowerCase().includes(needle)) : all;
  const chosen = new Set(value);
  // Keep the order of the list, as the old select box did.
  const toggle = (v: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(v);
    else next.delete(v);
    onChange(all.map((o) => o.value).filter((x) => next.has(x)));
  };

  return (
    <div className="options-field">
      <div className="options-field__bar">
        <input type="search" placeholder="Filtern …" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted">{value.length} gewählt</span>
        {value.length > 0 && !disabled && (
          <button type="button" onClick={() => onChange([])}>
            Auswahl leeren
          </button>
        )}
      </div>
      {error && <p className="error">Liste konnte nicht geladen werden: {error}</p>}
      {!options && !error && <p className="muted">Lade Liste …</p>}
      <div className="options-field__list">
        {shown.map((o) => (
          <label key={o.value} className="field--check">
            <input type="checkbox" checked={chosen.has(o.value)} disabled={disabled} onChange={(e) => toggle(o.value, e.target.checked)} />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}
