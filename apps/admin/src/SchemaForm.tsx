// Renders an edit form from a slide type's JSON schema (generated from its Zod
// config). New slide types get a working form without admin code changes.
import { lazy, Suspense } from 'react';
import type { Ecc } from '@foyer/qr-art';
import type { JsonSchemaProperty, User } from './api.ts';
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

export function SchemaForm({ schema, value, onChange, disabled, user, onError = () => undefined }: Props) {
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
                    <option key={option} value={option}>{option}</option>
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
