import { describe, expect, it } from 'vitest';
import { clientIp, ipInCidr } from '../apps/server/src/net.ts';
import { hashPassword, verifyPassword } from '../apps/server/src/crypto.ts';
import { displayState } from '../apps/server/src/status.ts';
import { EventHub } from '../apps/server/src/events.ts';
import { fillPlaceholders } from '../packages/slide-sdk/src/runtime.ts';
import { buildDocument, parseVariables } from '../slide-types/html/document.ts';
import { config as htmlConfig } from '../slide-types/html/index.ts';

describe('Netzprüfung', () => {
  it('prüft IPv4-Netze', () => {
    expect(ipInCidr('192.168.10.5', '192.168.0.0/16')).toBe(true);
    expect(ipInCidr('192.169.0.1', '192.168.0.0/16')).toBe(false);
    expect(ipInCidr('10.0.0.1', '10.0.0.1')).toBe(true);
    expect(ipInCidr('172.31.255.255', '172.16.0.0/12')).toBe(true);
    expect(ipInCidr('172.32.0.0', '172.16.0.0/12')).toBe(false);
  });

  it('prüft IPv6 und IPv4-gemappte Adressen', () => {
    expect(ipInCidr('::1', '::1/128')).toBe(true);
    expect(ipInCidr('fd12:3456::1', 'fc00::/7')).toBe(true);
    expect(ipInCidr('2001:db8::1', 'fc00::/7')).toBe(false);
    expect(ipInCidr('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true);
  });

  it('ermittelt die Client-IP nur über vertrauenswürdige Proxys', () => {
    expect(clientIp('8.8.8.8', '10.0.0.1', ['127.0.0.1'])).toBe('8.8.8.8');
    expect(clientIp('127.0.0.1', '10.0.0.1', ['127.0.0.1'])).toBe('10.0.0.1');
    expect(clientIp('127.0.0.1', '1.2.3.4, 10.0.0.1', ['127.0.0.1'])).toBe('10.0.0.1');
  });
});

describe('Display-Status', () => {
  const now = 1_000_000_000;
  const longAgoStarted = now - 3600_000;

  it('ist online bei Live-Verbindung oder frischem Lebenszeichen', () => {
    expect(displayState({ connected: true, lastSeenAt: null, now, serverStartedAt: longAgoStarted })).toBe('online');
    // Player ohne EventSource: nur Heartbeats
    expect(displayState({ connected: false, lastSeenAt: now - 60_000, now, serverStartedAt: longAgoStarted })).toBe('online');
  });

  it('ist offline nach 90 s ohne Lebenszeichen', () => {
    expect(displayState({ connected: false, lastSeenAt: now - 90_000, now, serverStartedAt: longAgoStarted })).toBe('offline');
  });

  it('unterscheidet "noch nie verbunden"', () => {
    expect(displayState({ connected: false, lastSeenAt: null, now, serverStartedAt: longAgoStarted })).toBe('never');
  });

  it('meldet kurz nach dem Serverstart "wird geprüft" statt offline', () => {
    expect(displayState({ connected: false, lastSeenAt: now - 600_000, now, serverStartedAt: now - 10_000 })).toBe('checking');
    expect(displayState({ connected: false, lastSeenAt: null, now, serverStartedAt: now - 10_000 })).toBe('never');
  });
});

describe('Passwörter', () => {
  it('hasht mit scrypt und verifiziert', async () => {
    const hash = await hashPassword('ein-langes-passwort');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('ein-langes-passwort', hash)).toBe(true);
    expect(await verifyPassword('falsch', hash)).toBe(false);
  });
});

describe('Platzhalter', () => {
  const ctx = { locale: 'de-DE', timeZone: 'Europe/Berlin', displayName: 'Aula', now: new Date('2026-11-04T10:05:00Z') };

  it('ersetzt eingebaute Platzhalter in der Schulzeitzone', () => {
    expect(fillPlaceholders('{{date}} {{time}} {{display.name}}', ctx)).toBe('04.11.2026 11:05 Aula');
  });

  it('lässt unbekannte Platzhalter stehen und nutzt eigene Werte', () => {
    expect(fillPlaceholders('{{foo}} {{name}}', { ...ctx, values: { name: 'Mensa' } })).toBe('{{foo}} Mensa');
  });
});

describe('HTML-Folie', () => {
  it('liest Platzhalter-Variablen', () => {
    expect(parseVariables('titel=Sommerfest\nfarbe = #f00\nohne-gleich')).toEqual({ titel: 'Sommerfest', farbe: '#f00' });
  });

  it('baut ein Dokument mit Laufzeit, Sandbox-CSP und entschärftem Script-Ende', () => {
    const config = htmlConfig.parse({ html: '<p>{{titel}}</p>', css: 'p{color:red}</style>', js: 'a("</script>")', variables: 'titel=Hallo' });
    const doc = buildDocument(config, { locale: 'de-DE', timeZone: 'Europe/Berlin', displayName: 'Aula' });
    expect(doc.html).toContain('<p>Hallo</p>');
    expect(doc.html).toContain('a("<\\/script>")');
    expect(doc.html).toContain('<\\/style>');
    expect(doc.csp).toContain("connect-src 'none'");
    expect(doc.csp).not.toContain('https:');
  });

  it('erlaubt externe Ressourcen nur auf Wunsch', () => {
    const config = htmlConfig.parse({ allowExternal: true });
    expect(buildDocument(config, { locale: 'de-DE', timeZone: 'Europe/Berlin', displayName: '' }).csp).toContain('img-src data: blob: https:');
  });
});

describe('Ereignisse an Displays', () => {
  it('verliert eine neue Verbindung nicht, wenn die alte sich doppelt abmeldet', () => {
    const hub = new EventHub();
    const unsubscribeOld = hub.subscribe('d1', () => undefined);
    unsubscribeOld(); // Abbruch der alten Verbindung
    const received: string[] = [];
    hub.subscribe('d1', (event) => received.push(event)); // Display verbindet sich neu
    unsubscribeOld(); // Ende der Schleife der alten Verbindung, bis zu 25 s später
    hub.send('d1', 'identify');
    expect(received).toEqual(['identify']);
    expect(hub.connected('d1')).toBe(1);
  });
});
