// Create/edit dialog for calendar entries, modelled on the wp-foyer scheduler
// overlay: content, displays, start/end, repetition chips, end of series.
import { useMemo, useState } from 'react';
import type { Channel, Display, Schedule, ScheduleInput, Slide } from './api.ts';
import { describe, fromRRule, toRRule, WEEKDAYS, type Freq, type Recurrence } from './recurrence.ts';

export interface DialogTarget {
  /** Existing entry being edited, or null for a new one. */
  schedule: Schedule | null;
  /** The clicked occurrence of a series (for "nur dieser Termin"). */
  occurrence: { occId: string; start: string; end: string | null } | null;
  /** Prefill for new entries. */
  start: string;
  end: string | null;
}

interface Props {
  scope: 'display' | 'channel';
  channelId?: string;
  target: DialogTarget;
  channels: Channel[];
  slides: Slide[];
  displays: Display[];
  displayColor: (id: string) => string;
  canEdit: boolean;
  onSave: (input: ScheduleInput, mode: 'series' | 'occurrence') => Promise<void>;
  onDelete: (mode: 'series' | 'occurrence') => Promise<void>;
  onClose: () => void;
}

export function ScheduleDialog({ scope, channelId, target, channels, slides, displays, displayColor, canEdit, onSave, onDelete, onClose }: Props) {
  const existing = target.schedule;
  const isSeries = Boolean(existing?.rrule);
  const [mode, setMode] = useState<'series' | 'occurrence'>(isSeries && target.occurrence ? 'occurrence' : 'series');

  // For "nur dieser Termin" the times are the occurrence's, otherwise the entry's.
  const initialStart = mode === 'occurrence' && target.occurrence ? target.occurrence.start : existing?.start ?? target.start;
  const initialEnd = mode === 'occurrence' && target.occurrence ? target.occurrence.end : existing ? existing.end : target.end;

  const [contentKind, setContentKind] = useState<'channel' | 'slide'>(existing?.contentKind ?? (scope === 'channel' ? 'slide' : 'channel'));
  const [contentId, setContentId] = useState(existing?.contentId ?? '');
  const [displayIds, setDisplayIds] = useState<string[]>(existing?.displayIds ?? (displays.length === 1 ? [displays[0].id] : []));
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState<string>(initialEnd ?? '');
  const [openEnded, setOpenEnded] = useState(existing ? existing.end === null : target.end === null);
  const [exclusive, setExclusive] = useState(existing?.exclusive ?? false);
  const [rec, setRec] = useState<Recurrence>(() => fromRRule(existing?.rrule ?? null, existing?.start ?? target.start));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const occurrenceOnly = isSeries && mode === 'occurrence';
  const options = contentKind === 'channel' ? channels.map((c) => ({ id: c.id, label: c.name })) : slides.map((s) => ({ id: s.id, label: s.title }));
  const summary = useMemo(() => describe(rec, start), [rec, start]);
  const setFreq = (freq: Freq) => setRec({ ...rec, freq });

  const switchMode = (next: 'series' | 'occurrence') => {
    setMode(next);
    if (next === 'occurrence' && target.occurrence) {
      setStart(target.occurrence.start);
      setEnd(target.occurrence.end ?? '');
    } else if (existing) {
      setStart(existing.start);
      setEnd(existing.end ?? '');
    }
  };

  const save = async () => {
    setError('');
    if (!contentId) return setError(contentKind === 'channel' ? 'Bitte einen Channel wählen.' : 'Bitte eine Folie wählen.');
    if (scope === 'display' && !displayIds.length) return setError('Bitte mindestens ein Display wählen.');
    if (!start) return setError('Bitte einen Beginn angeben.');
    const finalEnd = openEnded && !occurrenceOnly ? null : end;
    if (finalEnd !== null && !finalEnd) return setError('Bitte ein Ende angeben oder „unbefristet“ wählen.');
    const rrule = occurrenceOnly ? existing!.rrule : openEnded ? null : toRRule(rec, start);
    setBusy(true);
    try {
      await onSave(
        { scope, channelId: channelId ?? null, contentKind, contentId, displayIds: scope === 'display' ? displayIds : [], start, end: finalEnd, rrule, exclusive },
        occurrenceOnly ? 'occurrence' : 'series',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const what = occurrenceOnly ? 'diesen Termin' : isSeries ? 'die ganze Serie' : 'diesen Termin';
    if (!confirm(`Wirklich ${what} löschen?`)) return;
    setBusy(true);
    try {
      await onDelete(occurrenceOnly ? 'occurrence' : 'series');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__box">
        <header className="modal__head">
          <h2>{existing ? 'Termin bearbeiten' : 'Neuer Termin'}</h2>
          <button onClick={onClose} aria-label="Schließen">×</button>
        </header>

        {isSeries && target.occurrence && (
          <div className="chips" role="radiogroup" aria-label="Bearbeiten">
            <label className={`chip ${mode === 'occurrence' ? 'is-active' : ''}`}>
              <input type="radio" checked={mode === 'occurrence'} onChange={() => switchMode('occurrence')} /> Nur dieser Termin
            </label>
            <label className={`chip ${mode === 'series' ? 'is-active' : ''}`}>
              <input type="radio" checked={mode === 'series'} onChange={() => switchMode('series')} /> Ganze Serie
            </label>
          </div>
        )}

        <div className="form">
          {scope === 'display' && !occurrenceOnly && (
            <div className="chips" role="radiogroup" aria-label="Inhalt">
              {(['channel', 'slide'] as const).map((kind) => (
                <label key={kind} className={`chip ${contentKind === kind ? 'is-active' : ''}`}>
                  <input
                    type="radio"
                    checked={contentKind === kind}
                    disabled={!canEdit}
                    onChange={() => {
                      setContentKind(kind);
                      setContentId('');
                    }}
                  />
                  {kind === 'channel' ? 'Channel' : 'Einzelne Folie'}
                </label>
              ))}
            </div>
          )}
          {!occurrenceOnly && (
            <label className="field">
              <span>{contentKind === 'channel' ? 'Channel' : 'Folie'}</span>
              <select value={contentId} disabled={!canEdit} onChange={(e) => setContentId(e.target.value)}>
                <option value="">– bitte wählen –</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </label>
          )}

          {scope === 'display' && !occurrenceOnly && (
            <div className="field">
              <span>Displays</span>
              <div className="chips">
                {displays.map((d) => (
                  <label key={d.id} className={`chip ${displayIds.includes(d.id) ? 'is-active' : ''}`}>
                    <input
                      type="checkbox"
                      checked={displayIds.includes(d.id)}
                      disabled={!canEdit}
                      onChange={(e) => setDisplayIds(e.target.checked ? [...displayIds, d.id] : displayIds.filter((x) => x !== d.id))}
                    />
                    <span className="swatch" style={{ background: displayColor(d.id) }} />
                    {d.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="row row--fields">
            <label className="field">
              <span>Beginn</span>
              <input type="datetime-local" value={start} disabled={!canEdit} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="field">
              <span>Ende</span>
              <input type="datetime-local" value={end} disabled={!canEdit || (openEnded && !occurrenceOnly)} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>
          {!occurrenceOnly && (
            <label className="field field--check">
              <input type="checkbox" checked={openEnded} disabled={!canEdit} onChange={(e) => setOpenEnded(e.target.checked)} />
              Unbefristet (läuft ab Beginn dauerhaft, ohne Wiederholung)
            </label>
          )}

          {!occurrenceOnly && !openEnded && (
            <fieldset className="fieldset">
              <legend>Wiederholung</legend>
              <div className="chips">
                {(
                  [
                    ['none', 'Einmalig'],
                    ['daily', 'Täglich'],
                    ['weekly', 'Wöchentlich'],
                    ['monthly', 'Monatlich'],
                  ] as Array<[Freq, string]>
                ).map(([freq, label]) => (
                  <label key={freq} className={`chip ${rec.freq === freq ? 'is-active' : ''}`}>
                    <input type="radio" checked={rec.freq === freq} disabled={!canEdit} onChange={() => setFreq(freq)} /> {label}
                  </label>
                ))}
              </div>
              {rec.freq !== 'none' && (
                <>
                  <label className="field field--inline">
                    <span>Alle</span>
                    <input type="number" min={1} max={52} value={rec.interval} disabled={!canEdit} onChange={(e) => setRec({ ...rec, interval: Math.max(1, Number(e.target.value)) })} />
                    <span>{rec.freq === 'daily' ? 'Tag(e)' : rec.freq === 'weekly' ? 'Woche(n)' : 'Monat(e)'}</span>
                  </label>
                  {rec.freq === 'weekly' && (
                    <div className="chips">
                      {WEEKDAYS.map((d) => (
                        <label key={d.code} className={`chip ${rec.byday.includes(d.code) ? 'is-active' : ''}`}>
                          <input
                            type="checkbox"
                            checked={rec.byday.includes(d.code)}
                            disabled={!canEdit}
                            onChange={(e) => setRec({ ...rec, byday: e.target.checked ? [...rec.byday, d.code] : rec.byday.filter((x) => x !== d.code) })}
                          />
                          {d.short}
                        </label>
                      ))}
                    </div>
                  )}
                  {rec.freq === 'monthly' && (
                    <div className="chips">
                      <label className={`chip ${rec.monthly === 'monthday' ? 'is-active' : ''}`}>
                        <input type="radio" checked={rec.monthly === 'monthday'} disabled={!canEdit} onChange={() => setRec({ ...rec, monthly: 'monthday' })} />
                        Am gleichen Tag des Monats
                      </label>
                      <label className={`chip ${rec.monthly === 'weekday' ? 'is-active' : ''}`}>
                        <input type="radio" checked={rec.monthly === 'weekday'} disabled={!canEdit} onChange={() => setRec({ ...rec, monthly: 'weekday' })} />
                        Am gleichen Wochentag (z. B. 2. Dienstag)
                      </label>
                    </div>
                  )}
                  <div className="chips">
                    <label className={`chip ${rec.end === 'never' ? 'is-active' : ''}`}>
                      <input type="radio" checked={rec.end === 'never'} disabled={!canEdit} onChange={() => setRec({ ...rec, end: 'never' })} /> Endet nie
                    </label>
                    <label className={`chip ${rec.end === 'until' ? 'is-active' : ''}`}>
                      <input type="radio" checked={rec.end === 'until'} disabled={!canEdit} onChange={() => setRec({ ...rec, end: 'until' })} /> Endet am
                      <input type="date" value={rec.until} disabled={!canEdit || rec.end !== 'until'} onChange={(e) => setRec({ ...rec, until: e.target.value })} />
                    </label>
                    <label className={`chip ${rec.end === 'count' ? 'is-active' : ''}`}>
                      <input type="radio" checked={rec.end === 'count'} disabled={!canEdit} onChange={() => setRec({ ...rec, end: 'count' })} /> Endet nach
                      <input type="number" min={1} value={rec.count} disabled={!canEdit || rec.end !== 'count'} onChange={(e) => setRec({ ...rec, count: Math.max(1, Number(e.target.value)) })} />
                      Terminen
                    </label>
                  </div>
                </>
              )}
              <p className="muted">{summary}</p>
            </fieldset>
          )}

          {scope === 'display' && !occurrenceOnly && (
            <label className="field field--check" title="Solange dieser Termin läuft, zeigt das Display nur exklusive Inhalte.">
              <input type="checkbox" checked={exclusive} disabled={!canEdit} onChange={(e) => setExclusive(e.target.checked)} />
              Exklusiv: solange er läuft, nur diesen Inhalt zeigen
            </label>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        {canEdit && (
          <footer className="row">
            <button className="primary" disabled={busy} onClick={save}>Speichern</button>
            {existing && (
              <button className="danger" disabled={busy} onClick={remove}>
                {occurrenceOnly ? 'Diesen Termin löschen' : isSeries ? 'Serie löschen' : 'Löschen'}
              </button>
            )}
            <button onClick={onClose}>Abbrechen</button>
          </footer>
        )}
      </div>
    </div>
  );
}

export function emptyTarget(start: string, end: string | null): DialogTarget {
  return { schedule: null, occurrence: null, start, end };
}

