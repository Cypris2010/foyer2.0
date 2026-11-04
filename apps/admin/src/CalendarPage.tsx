// Display calendar: plan channels or single slides on displays (wp-foyer scheduler).
import { useEffect, useState } from 'react';
import { api, can, type Channel, type Display, type Slide, type User } from './api.ts';
import { colorFor, ScheduleCalendar } from './ScheduleCalendar.tsx';

export function CalendarPage({ user, onError }: { user: User; onError: (e: unknown) => void }) {
  const [displays, setDisplays] = useState<Display[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [filter, setFilter] = useState<string[]>([]);

  useEffect(() => {
    Promise.all([api.get<Display[]>('/displays'), api.get<Channel[]>('/channels'), api.get<Slide[]>('/slides')])
      .then(([d, c, s]) => {
        setDisplays(d);
        setChannels(c);
        setSlides(s);
      })
      .catch(onError);
  }, []);

  if (!displays) return null;
  const ids = displays.map((d) => d.id);
  const toggle = (id: string) => setFilter(filter.includes(id) ? filter.filter((x) => x !== id) : [...filter, id]);

  return (
    <section>
      <h1>Kalender</h1>
      <p className="muted">
        Plane Channels oder einzelne Folien auf Displays. Ein geplanter Channel ersetzt den Standard-Channel; laufen mehrere gleichzeitig, werden
        sie gekoppelt. Einzelne Folien kommen zum laufenden Programm hinzu. „Exklusiv“ zeigt nur diesen Inhalt.
      </p>
      <div className="chips">
        <span className="muted">Anzeigen für:</span>
        <label className={`chip ${filter.length === 0 ? 'is-active' : ''}`}>
          <input type="checkbox" checked={filter.length === 0} onChange={() => setFilter([])} /> Alle Displays
        </label>
        {displays.map((d) => (
          <label key={d.id} className={`chip ${filter.includes(d.id) ? 'is-active' : ''}`}>
            <input type="checkbox" checked={filter.includes(d.id)} onChange={() => toggle(d.id)} />
            <span className="swatch" style={{ background: colorFor(ids, d.id) }} />
            {d.name}
          </label>
        ))}
      </div>
      <ScheduleCalendar
        scope="display"
        channels={channels}
        slides={slides}
        displays={displays}
        displayFilter={filter}
        canEdit={can(user, 'editor')}
        onError={onError}
      />
    </section>
  );
}
