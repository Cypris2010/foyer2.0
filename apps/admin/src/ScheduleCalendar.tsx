// Calendar view (EventCalendar, as in wp-foyer) for both levels:
//   scope "display": channels or single slides on displays
//   scope "channel": when the slides of one channel play
// Week view by default, plus month and list; click or drag to create, click to
// edit, drag/resize to move a single occurrence.
import { useEffect, useRef, useState } from 'react';
import { createCalendar, destroyCalendar, DayGrid, Interaction, List, TimeGrid, type Calendar } from '@event-calendar/core';
import '@event-calendar/core/index.css';
import { api, type Channel, type Display, type Schedule, type ScheduleInput, type ScheduleOccurrence, type Slide } from './api.ts';
import { emptyTarget, ScheduleDialog, type DialogTarget } from './ScheduleDialog.tsx';

const pad = (n: number) => String(n).padStart(2, '0');
/** Browser-local Date → "YYYY-MM-DDTHH:mm". The admin runs in the school's time zone. */
export const toLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const plusMinutes = (local: string, minutes: number) => toLocal(new Date(new Date(local).getTime() + minutes * 60_000));

const PALETTE = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777'];
export const colorFor = (ids: string[], id: string) => PALETTE[Math.max(0, ids.indexOf(id)) % PALETTE.length];

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Label for open-ended entries; the migration marks "always" with a start in 2000. */
const unbounded = (startLocal: string) =>
  startLocal < '2001' ? 'unbefristet' : `unbefristet ab ${startLocal.slice(8, 10)}.${startLocal.slice(5, 7)}.${startLocal.slice(0, 4)}, ${startLocal.slice(11)}`;

interface Props {
  scope: 'display' | 'channel';
  channelId?: string;
  channels: Channel[];
  slides: Slide[];
  displays: Display[];
  /** Display scope: only show entries for these displays (empty = all). */
  displayFilter?: string[];
  canEdit: boolean;
  onChanged?: () => void;
  onError: (e: unknown) => void;
}

export function ScheduleCalendar({ scope, channelId, channels, slides, displays, displayFilter = [], canEdit, onChanged, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const calendar = useRef<Calendar | null>(null);
  const range = useRef<{ from: string; to: string } | null>(null);
  const [target, setTarget] = useState<DialogTarget | null>(null);
  const displayIds = displays.map((d) => d.id);
  const slideIds = slides.map((s) => s.id);

  // Latest props for the calendar callbacks, which are created once.
  const latest = useRef({ scope, channelId, displayFilter, canEdit, displayIds, slideIds, onError });
  latest.current = { scope, channelId, displayFilter, canEdit, displayIds, slideIds, onError };

  const load = async () => {
    const cal = calendar.current;
    const r = range.current;
    if (!cal || !r) return;
    const p = latest.current;
    const query = new URLSearchParams({ scope: p.scope, from: r.from, to: r.to });
    if (p.channelId) query.set('channelId', p.channelId);
    if (p.displayFilter.length) query.set('displayIds', p.displayFilter.join(','));
    try {
      const occurrences = await api.get<ScheduleOccurrence[]>(`/schedules?${query}`);
      cal.setOption(
        'events',
        occurrences.map((o) => {
          const color = p.scope === 'display' ? colorFor(p.displayIds, o.displayIds[0]) : colorFor(p.slideIds, o.contentId);
          const openEnded = o.occEnd === null;
          return {
            id: `${o.id}::${o.occId}`,
            start: o.occStart.replace('T', ' '),
            // Open-ended entries show as all-day bars up to the end of the view.
            end: (o.occEnd ?? r.to).replace('T', ' '),
            allDay: openEnded,
            title: o.title,
            backgroundColor: o.exclusive ? '#b91c1c' : color,
            editable: p.canEdit && !openEnded,
            extendedProps: { occurrence: o },
          };
        }),
      );
    } catch (e) {
      p.onError(e);
    }
  };

  useEffect(() => {
    if (!host.current) return;
    const cal = createCalendar(host.current, [TimeGrid, DayGrid, List, Interaction], {
      view: 'timeGridWeek',
      locale: 'de',
      firstDay: 1,
      height: '720px',
      nowIndicator: true,
      allDaySlot: true,
      allDayContent: 'Dauerhaft',
      scrollTime: '07:00:00',
      slotDuration: '00:30:00',
      selectable: latest.current.canEdit,
      editable: latest.current.canEdit,
      headerToolbar: { start: 'title', center: '', end: 'today prev,next dayGridMonth,timeGridWeek,listMonth' },
      buttonText: { today: 'Heute', dayGridMonth: 'Monat', timeGridWeek: 'Woche', listMonth: 'Liste' } as any,
      views: { dayGridMonth: { dayMaxEvents: true }, listMonth: { noEventsContent: 'Keine Termine' } as any },
      eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      eventContent: (info) => {
        const o = (info.event.extendedProps as { occurrence: ScheduleOccurrence }).occurrence;
        const p = latest.current;
        const swatches =
          p.scope === 'display'
            ? o.displayIds.map((d) => `<span class="ev-swatch" style="background:${colorFor(p.displayIds, d)}"></span>`).join('')
            : '';
        const marks = [o.exclusive ? 'exklusiv' : '', o.overlaps ? 'gekoppelt' : '', o.rrule ? 'Serie' : ''].filter(Boolean);
        const kind = o.scope === 'display' && o.contentKind === 'slide' ? 'Folie: ' : '';
        return {
          html:
            // Title first: short entries only have room for one or two lines.
            `<div class="ev"><div class="ev-title">${swatches}${escapeHtml(kind + o.title)}</div>` +
            `<div class="ev-meta">${escapeHtml([o.occEnd === null ? unbounded(o.occStart) : info.timeText, ...marks].filter(Boolean).join(' · '))}</div>` +
            `</div>`,
        };
      },
      datesSet: (info) => {
        range.current = { from: toLocal(info.start), to: toLocal(info.end) };
        void load();
      },
      dateClick: (info) => {
        if (!latest.current.canEdit) return;
        const start = info.allDay ? `${toLocal(info.date).slice(0, 10)}T08:00` : toLocal(info.date);
        setTarget(emptyTarget(start, info.allDay ? null : plusMinutes(start, 60)));
      },
      select: (info) => {
        if (!latest.current.canEdit) return;
        calendar.current?.unselect();
        if (info.allDay) setTarget(emptyTarget(`${toLocal(info.start).slice(0, 10)}T08:00`, null));
        else setTarget(emptyTarget(toLocal(info.start), toLocal(info.end)));
      },
      eventClick: async (info) => {
        const o = (info.event.extendedProps as { occurrence: ScheduleOccurrence }).occurrence;
        try {
          const schedule = await api.get<Schedule>(`/schedules/${o.id}`);
          setTarget({ schedule, occurrence: { occId: o.occId, start: o.occStart, end: o.occEnd }, start: o.occStart, end: o.occEnd });
        } catch (e) {
          latest.current.onError(e);
        }
      },
      // Dragging always moves only the dragged occurrence (as in wp-foyer).
      eventDrop: (info) => void move(info.event, info.revert),
      eventResize: (info) => void move(info.event, info.revert),
    });
    calendar.current = cal;
    return () => {
      calendar.current = null;
      void destroyCalendar(cal);
    };
  }, []);

  // Reload when the filter or the channel changes.
  useEffect(() => {
    void load();
  }, [channelId, displayFilter.join(',')]);

  const move = async (event: Calendar.Event, revert: () => void) => {
    const o = (event.extendedProps as { occurrence: ScheduleOccurrence }).occurrence;
    if (!event.end) return revert();
    try {
      await api.patch(`/schedules/${o.id}/occurrences/${encodeURIComponent(o.occId)}`, { start: toLocal(event.start), end: toLocal(event.end) });
      await load();
      onChanged?.();
    } catch (e) {
      revert();
      onError(e);
    }
  };

  const save = async (input: ScheduleInput, mode: 'series' | 'occurrence') => {
    const existing = target?.schedule;
    if (existing && mode === 'occurrence' && target?.occurrence) {
      await api.patch(`/schedules/${existing.id}/occurrences/${encodeURIComponent(target.occurrence.occId)}`, { start: input.start, end: input.end });
    } else if (existing) {
      await api.put(`/schedules/${existing.id}`, input);
    } else {
      await api.post('/schedules', input);
    }
    setTarget(null);
    await load();
    onChanged?.();
  };

  const remove = async (mode: 'series' | 'occurrence') => {
    const existing = target?.schedule;
    if (!existing) return;
    if (mode === 'occurrence' && target?.occurrence) await api.del(`/schedules/${existing.id}/occurrences/${encodeURIComponent(target.occurrence.occId)}`);
    else await api.del(`/schedules/${existing.id}`);
    setTarget(null);
    await load();
    onChanged?.();
  };

  /** New entry from the button: slides in a channel default to "from now, open-ended". */
  const openNew = () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const start = toLocal(now);
    setTarget(emptyTarget(start, scope === 'channel' ? null : plusMinutes(start, 60)));
  };

  return (
    <div className="schedule-calendar">
      {canEdit && (
        <div className="row">
          <button className="primary" onClick={openNew}>{scope === 'channel' ? 'Folie einplanen' : 'Termin anlegen'}</button>
          <span className="muted">Oder im Kalender klicken bzw. einen Zeitraum ziehen.</span>
        </div>
      )}
      <div ref={host} />
      {target && (
        <ScheduleDialog
          scope={scope}
          channelId={channelId}
          target={target}
          channels={channels}
          slides={slides}
          displays={displays}
          displayColor={(id) => colorFor(displayIds, id)}
          canEdit={canEdit}
          onSave={save}
          onDelete={remove}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  );
}
