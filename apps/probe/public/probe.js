/* Foyer device probe. Deliberately ES5 with callbacks only, so it runs on old
 * embedded browsers (Airtame). Measures what the Foyer player depends on and
 * posts one JSON report per run to /api/report. Needs no input: it runs on
 * load, shows the results on screen and can be re-run by reloading. */
(function () {
  'use strict';

  var params = parseQuery(location.search);
  var deviceName = params.device || 'unbekannt';
  var report = {
    probeVersion: 1,
    device: deviceName,
    startedAt: new Date().toISOString(),
    browser: {},
    screen: {},
    features: {},
    css: {},
    js: {},
    storage: {},
    serviceWorker: {},
    codecs: {},
    animation: [],
    video: [],
    autoplay: {},
    errors: []
  };

  var resultsNode = document.getElementById('results');
  var statusNode = document.getElementById('status');
  var stage = document.getElementById('stage');
  document.getElementById('device').textContent = '· ' + deviceName;

  window.onerror = function (message, source, line) {
    report.errors.push(String(message) + ' @' + line);
  };

  function parseQuery(search) {
    var out = {};
    search.replace(/^\?/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var parts = pair.split('=');
      out[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
    });
    return out;
  }

  function setStatus(text) {
    statusNode.textContent = text;
  }

  function addGroup(title, rows) {
    var group = document.createElement('div');
    group.className = 'group';
    var heading = document.createElement('h2');
    heading.textContent = title;
    group.appendChild(heading);
    rows.forEach(function (row) {
      var line = document.createElement('div');
      line.className = 'row';
      var label = document.createElement('span');
      label.textContent = row[0];
      var value = document.createElement('span');
      value.textContent = row[1];
      if (row[2]) value.className = row[2];
      line.appendChild(label);
      line.appendChild(value);
      group.appendChild(line);
    });
    resultsNode.appendChild(group);
  }

  function yesNo(value) {
    return value ? ['ja', 'ok'] : ['nein', 'bad'];
  }

  function row(label, value) {
    var yn = yesNo(value);
    return [label, yn[0], yn[1]];
  }

  // Runs the async steps one after another; each step calls next() when done.
  function sequence(steps, done) {
    var index = 0;
    function next() {
      if (index >= steps.length) return done();
      var step = steps[index++];
      try {
        step(next);
      } catch (err) {
        report.errors.push(String(err && err.message || err));
        next();
      }
    }
    next();
  }

  function percentile(values, p) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  function round(value, digits) {
    var factor = Math.pow(10, digits || 0);
    return Math.round(value * factor) / factor;
  }

  // --- Step: browser, screen, features --------------------------------------

  function collectEnvironment(next) {
    var ua = navigator.userAgent;
    var chromium = ua.match(/(?:Chrome|Chromium|HeadlessChrome)\/([\d.]+)/);
    var webkit = ua.match(/AppleWebKit\/([\d.]+)/);
    report.browser = {
      userAgent: ua,
      chromium: chromium ? chromium[1] : null,
      webkit: webkit ? webkit[1] : null,
      language: navigator.language,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemory: navigator.deviceMemory || null,
      timeZone: (window.Intl && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : null
    };
    report.screen = {
      width: screen.width,
      height: screen.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    };
    if (window.performance && performance.memory) {
      report.browser.memory = {
        jsHeapSizeLimitMB: round(performance.memory.jsHeapSizeLimit / 1048576),
        usedJSHeapSizeMB: round(performance.memory.usedJSHeapSize / 1048576)
      };
    }

    var f = report.features;
    f.serviceWorker = 'serviceWorker' in navigator;
    f.cacheApi = 'caches' in window;
    f.indexedDB = 'indexedDB' in window;
    f.opfs = !!(navigator.storage && navigator.storage.getDirectory);
    f.storageEstimate = !!(navigator.storage && navigator.storage.estimate);
    f.storagePersist = !!(navigator.storage && navigator.storage.persist);
    f.fetch = 'fetch' in window;
    f.abortController = 'AbortController' in window;
    f.eventSource = 'EventSource' in window;
    f.webSocket = 'WebSocket' in window;
    f.mutationObserver = 'MutationObserver' in window;
    f.intersectionObserver = 'IntersectionObserver' in window;
    f.resizeObserver = 'ResizeObserver' in window;
    f.webAnimations = typeof document.body.animate === 'function';
    f.requestIdleCallback = 'requestIdleCallback' in window;
    f.intlFormatToParts = !!(window.Intl && Intl.DateTimeFormat && Intl.DateTimeFormat.prototype.formatToParts);
    f.intlTimeZone = (function () {
      try { new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin' }); return true; } catch (e) { return false; }
    })();
    f.videoPlaybackQuality = typeof document.createElement('video').getVideoPlaybackQuality === 'function';
    f.webgl = (function () {
      try {
        var canvas = document.createElement('canvas');
        return !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
      } catch (e) { return false; }
    })();
    f.iframeSrcdoc = 'srcdoc' in document.createElement('iframe');
    f.iframeSandbox = 'sandbox' in document.createElement('iframe');

    var supports = window.CSS && CSS.supports ? function (a, b) { return CSS.supports(a, b); } : function () { return false; };
    report.css = {
      grid: supports('display', 'grid'),
      flexGap: supports('gap', '1px'),
      inset: supports('inset', '0'),
      aspectRatio: supports('aspect-ratio', '16 / 9'),
      objectFit: supports('object-fit', 'cover'),
      customProperties: supports('--a', '0'),
      backdropFilter: supports('backdrop-filter', 'blur(4px)') || supports('-webkit-backdrop-filter', 'blur(4px)'),
      filter: supports('filter', 'blur(4px)'),
      containerQueries: supports('container-type', 'inline-size'),
      has: supports('selector(:has(a))', '') || (function () { try { document.querySelector(':has(a)'); return true; } catch (e) { return false; } })(),
      clamp: supports('width', 'clamp(1px, 2px, 3px)'),
      vmin: supports('width', '1vmin')
    };

    report.js = {
      es2015: syntax('let a = 1; const b = () => a; class C {}'),
      es2017: syntax('async function f() { await 1; }'),
      es2018: syntax('const { a, ...rest } = { a: 1, b: 2 };'),
      es2020: syntax('const a = null; a?.b ?? 1;'),
      es2022: syntax('class C { #x = 1; static y = 2; }'),
      modules: 'noModule' in document.createElement('script')
    };

    var e = report.browser;
    addGroup('Browser', [
      ['Chromium', e.chromium || '–', e.chromium ? 'ok' : 'warn'],
      ['WebKit', e.webkit || '–'],
      ['CPU-Kerne', String(e.hardwareConcurrency || '–')],
      ['Zeitzone', e.timeZone || '–'],
      ['Bildschirm', report.screen.width + '×' + report.screen.height + ' @' + report.screen.devicePixelRatio],
      ['Viewport', report.screen.innerWidth + '×' + report.screen.innerHeight],
      ['JS-Heap-Limit', e.memory ? e.memory.jsHeapSizeLimitMB + ' MB' : '–']
    ]);
    addGroup('JavaScript', [
      row('ES2015', report.js.es2015), row('ES2017 async', report.js.es2017),
      row('ES2020 ?. ??', report.js.es2020), row('ES2022 Klassenfelder', report.js.es2022),
      row('ES-Module', report.js.modules)
    ]);
    addGroup('APIs', [
      row('Service Worker', f.serviceWorker), row('Cache API', f.cacheApi), row('IndexedDB', f.indexedDB),
      row('OPFS', f.opfs), row('EventSource (SSE)', f.eventSource), row('WebSocket', f.webSocket),
      row('Web Animations', f.webAnimations), row('Intl timeZone', f.intlTimeZone),
      row('VideoPlaybackQuality', f.videoPlaybackQuality), row('iframe sandbox/srcdoc', f.iframeSandbox && f.iframeSrcdoc),
      row('WebGL', f.webgl)
    ]);
    addGroup('CSS', [
      row('Grid', report.css.grid), row('Flex gap', report.css.flexGap), row('inset', report.css.inset),
      row('aspect-ratio', report.css.aspectRatio), row('backdrop-filter', report.css.backdropFilter),
      row('Container Queries', report.css.containerQueries), row(':has()', report.css.has)
    ]);
    next();
  }

  function syntax(source) {
    try {
      new Function(source);
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- Step: storage persistence (survives reboot?) -------------------------

  var MARKER_KEY = 'foyer-probe-marker';

  function collectStorage(next) {
    var now = new Date().toISOString();
    var s = report.storage;

    var previous = null;
    try {
      previous = JSON.parse(localStorage.getItem(MARKER_KEY) || 'null');
      s.localStorage = true;
    } catch (e) {
      s.localStorage = false;
    }
    s.loadCount = previous ? previous.loadCount + 1 : 1;
    s.localStoragePrevious = previous;
    try {
      localStorage.setItem(MARKER_KEY, JSON.stringify({ loadCount: s.loadCount, firstSeen: previous ? previous.firstSeen : now, lastSeen: now }));
    } catch (e) {
      s.localStorageWriteError = String(e);
    }

    var cookieMatch = document.cookie.match(/foyerProbe=([^;]+)/);
    s.cookiePrevious = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
    document.cookie = 'foyerProbe=' + encodeURIComponent(now) + '; max-age=31536000; path=/; SameSite=Lax';

    sequence([indexedDbMarker, cacheMarker, storageEstimate], function () {
      addGroup('Speicher (Lauf #' + s.loadCount + ')', [
        ['localStorage vorher', previous ? 'ja, seit ' + previous.firstSeen.slice(0, 16) : 'nein', previous ? 'ok' : 'warn'],
        ['Cookie vorher', s.cookiePrevious ? 'ja' : 'nein', s.cookiePrevious ? 'ok' : 'warn'],
        ['IndexedDB vorher', s.indexedDBPrevious ? 'ja' : (s.indexedDBError ? 'Fehler' : 'nein'), s.indexedDBPrevious ? 'ok' : 'warn'],
        ['Cache API vorher', s.cachePrevious ? 'ja' : (s.cacheError ? 'Fehler' : 'nein'), s.cachePrevious ? 'ok' : 'warn'],
        ['Quota', s.quotaMB ? s.quotaMB + ' MB (belegt ' + s.usageMB + ' MB)' : '–'],
        ['Persistent', s.persisted === undefined ? '–' : String(s.persisted)]
      ]);
      next();
    });
  }

  function indexedDbMarker(next) {
    var s = report.storage;
    if (!window.indexedDB) return next();
    var finished = false;
    function finish() { if (!finished) { finished = true; next(); } }
    setTimeout(function () { if (!finished) { s.indexedDBError = s.indexedDBError || 'timeout'; finish(); } }, 3000);
    try {
      var request = indexedDB.open('foyer-probe', 1);
      request.onupgradeneeded = function () { request.result.createObjectStore('marker'); };
      request.onerror = function () { s.indexedDBError = String(request.error); finish(); };
      request.onsuccess = function () {
        var db = request.result;
        var tx = db.transaction('marker', 'readwrite');
        var store = tx.objectStore('marker');
        var get = store.get('marker');
        get.onsuccess = function () {
          s.indexedDBPrevious = get.result || null;
          store.put(new Date().toISOString(), 'marker');
        };
        tx.oncomplete = function () { db.close(); finish(); };
        tx.onerror = function () { s.indexedDBError = String(tx.error); finish(); };
      };
    } catch (e) {
      s.indexedDBError = String(e);
      finish();
    }
  }

  function cacheMarker(next) {
    var s = report.storage;
    if (!window.caches) return next();
    var url = '/__foyer-probe-marker';
    caches.open('foyer-probe').then(function (cache) {
      return cache.match(url).then(function (hit) {
        return (hit ? hit.text() : Promise.resolve(null)).then(function (text) {
          s.cachePrevious = text;
          return cache.put(url, new Response(new Date().toISOString()));
        });
      });
    }).then(next, function (err) {
      s.cacheError = String(err);
      next();
    });
  }

  function storageEstimate(next) {
    var s = report.storage;
    if (!(navigator.storage && navigator.storage.estimate)) return next();
    navigator.storage.estimate().then(function (estimate) {
      s.quotaMB = round((estimate.quota || 0) / 1048576);
      s.usageMB = round((estimate.usage || 0) / 1048576, 1);
      return navigator.storage.persisted ? navigator.storage.persisted() : undefined;
    }).then(function (persisted) {
      s.persisted = persisted;
      next();
    }, function (err) {
      s.estimateError = String(err);
      next();
    });
  }

  // --- Step: service worker -------------------------------------------------

  function collectServiceWorker(next) {
    var sw = report.serviceWorker;
    if (!('serviceWorker' in navigator)) {
      sw.supported = false;
      return next();
    }
    sw.supported = true;
    sw.secureContext = window.isSecureContext;
    navigator.serviceWorker.register('/sw.js').then(function (registration) {
      sw.registered = true;
      sw.previouslyActive = !!navigator.serviceWorker.controller;
      sw.scope = registration.scope;
      next();
    }, function (err) {
      sw.registered = false;
      sw.error = String(err);
      next();
    });
  }

  // --- Step: animation performance -----------------------------------------

  function measureFrames(durationMs, done) {
    var intervals = [];
    var last = null;
    var start = null;
    function tick(ts) {
      if (start === null) start = ts;
      if (last !== null) intervals.push(ts - last);
      last = ts;
      if (ts - start < durationMs) {
        requestAnimationFrame(tick);
      } else {
        var total = intervals.reduce(function (a, b) { return a + b; }, 0);
        done({
          frames: intervals.length,
          fps: round(intervals.length / (total / 1000), 1),
          avg: round(total / Math.max(1, intervals.length), 1),
          p95: round(percentile(intervals, 0.95), 1),
          longFrames: intervals.filter(function (v) { return v > 50; }).length
        });
      }
    }
    requestAnimationFrame(tick);
  }

  function animationScene(id, label, build) {
    return function (next) {
      setStatus('Animation: ' + label);
      stage.innerHTML = '';
      stage.className = 'active';
      var cleanup = build(stage);
      var caption = document.createElement('div');
      caption.className = 'label';
      caption.textContent = label;
      stage.appendChild(caption);
      // Give layout a moment, then measure.
      setTimeout(function () {
        measureFrames(5000, function (result) {
          result.id = id;
          result.label = label;
          report.animation.push(result);
          if (cleanup) cleanup();
          stage.className = '';
          stage.innerHTML = '';
          next();
        });
      }, 300);
    };
  }

  function boxes(count, withShadow) {
    return function (root) {
      var nodes = [];
      for (var i = 0; i < count; i++) {
        var box = document.createElement('div');
        box.className = 'box';
        box.style.top = (5 + (i % 6) * 15) + '%';
        box.style.left = '0';
        if (withShadow) box.style.boxShadow = '0 2vmin 4vmin rgba(0,0,0,.5)';
        root.appendChild(box);
        nodes.push(box);
      }
      var running = true;
      var t0 = Date.now();
      (function frame() {
        if (!running) return;
        var t = (Date.now() - t0) / 1000;
        for (var j = 0; j < nodes.length; j++) {
          var x = (Math.sin(t * 1.5 + j) + 1) * 0.5 * (window.innerWidth - 120);
          nodes[j].style.transform = 'translateX(' + x + 'px) rotate(' + (t * 90 + j * 20) + 'deg)';
        }
        requestAnimationFrame(frame);
      })();
      return function () { running = false; };
    };
  }

  function crossfade(root) {
    var a = document.createElement('div');
    var b = document.createElement('div');
    a.className = b.className = 'layer';
    a.style.background = 'linear-gradient(135deg, #1d4ed8, #9333ea)';
    b.style.background = 'linear-gradient(135deg, #f59e0b, #dc2626)';
    a.style.transition = b.style.transition = 'opacity 1.5s ease';
    root.appendChild(a);
    root.appendChild(b);
    var visible = true;
    var timer = setInterval(function () {
      visible = !visible;
      b.style.opacity = visible ? '1' : '0';
    }, 1600);
    return function () { clearInterval(timer); };
  }

  function glass(root) {
    var stop = boxes(12, false)(root);
    var pane = document.createElement('div');
    pane.className = 'glass';
    pane.style.webkitBackdropFilter = 'blur(7px)';
    pane.style.backdropFilter = 'blur(7px)';
    root.appendChild(pane);
    return stop;
  }

  // --- Step: codecs and video playback --------------------------------------

  function collectCodecs(next) {
    var video = document.createElement('video');
    var types = {
      'h264-baseline': 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
      'h264-main': 'video/mp4; codecs="avc1.4D401F, mp4a.40.2"',
      'h264-high': 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
      'hevc': 'video/mp4; codecs="hvc1.1.6.L120.90"',
      'vp9': 'video/webm; codecs="vp9"',
      'av1': 'video/mp4; codecs="av01.0.08M.08"'
    };
    var rows = [];
    for (var key in types) {
      var answer = video.canPlayType(types[key]);
      report.codecs[key] = answer || 'no';
      rows.push([key, answer || 'nein', answer === 'probably' ? 'ok' : (answer ? 'warn' : 'bad')]);
    }
    addGroup('Codecs (canPlayType)', rows);
    next();
  }

  function loadClipList(done) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/clips/index.json');
    xhr.onload = function () {
      try { done(JSON.parse(xhr.responseText)); } catch (e) { done([]); }
    };
    xhr.onerror = function () { done([]); };
    xhr.send();
  }

  function playClip(clip, next) {
    setStatus('Video: ' + clip.label);
    stage.innerHTML = '';
    stage.className = 'active';
    var video = document.createElement('video');
    video.muted = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    var caption = document.createElement('div');
    caption.className = 'label';
    caption.textContent = clip.label;
    stage.appendChild(video);
    stage.appendChild(caption);

    var result = { id: clip.id, label: clip.label, waiting: 0 };
    var t0 = Date.now();
    var finished = false;
    var playTimer = null;

    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(playTimer);
      clearTimeout(watchdog);
      if (error) result.error = error;
      var quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
      var total = quality ? quality.totalVideoFrames : video.webkitDecodedFrameCount;
      var dropped = quality ? quality.droppedVideoFrames : video.webkitDroppedFrameCount;
      if (typeof total === 'number') {
        result.totalFrames = total;
        result.droppedFrames = dropped;
        result.droppedPercent = total ? round(dropped / total * 100, 1) : null;
      }
      result.playedSeconds = round(video.currentTime, 1);
      result.videoWidth = video.videoWidth;
      result.videoHeight = video.videoHeight;
      report.video.push(result);
      video.pause();
      video.removeAttribute('src');
      try { video.load(); } catch (e) {}
      stage.className = '';
      stage.innerHTML = '';
      setTimeout(next, 500);
    }

    var watchdog = setTimeout(function () { finish('timeout'); }, 30000);
    video.addEventListener('canplay', function () {
      if (result.canplayMs === undefined) result.canplayMs = Date.now() - t0;
    });
    video.addEventListener('canplaythrough', function () {
      if (result.canplaythroughMs === undefined) result.canplaythroughMs = Date.now() - t0;
    });
    video.addEventListener('playing', function () {
      if (result.playingMs !== undefined) return;
      result.playingMs = Date.now() - t0;
      playTimer = setTimeout(function () { finish(); }, 10000);
    });
    // Count only stalls during playback; the initial buffering before 'playing' is expected.
    video.addEventListener('waiting', function () {
      if (result.playingMs !== undefined) result.waiting++;
    });
    video.addEventListener('error', function () {
      finish('MediaError ' + (video.error ? video.error.code : '?'));
    });
    video.src = '/clips/' + clip.id + '.mp4';
    var promise = video.play();
    if (promise && promise.catch) {
      promise.catch(function (err) { result.playRejected = String(err); });
    }
  }

  function collectVideo(next) {
    loadClipList(function (clips) {
      if (!clips.length) {
        report.video.push({ error: 'keine Clips gefunden' });
        return next();
      }
      sequence(clips.map(function (clip) {
        return function (done) { playClip(clip, done); };
      }), function () {
        addGroup('Video (10 s, stumm)', report.video.map(function (v) {
          if (v.error) return [v.label || v.id, v.error, 'bad'];
          var text = v.droppedPercent + ' % verworfen · Start ' + v.playingMs + ' ms · ' + v.waiting + '× Puffer';
          var cls = v.droppedPercent < 1 && v.waiting === 0 ? 'ok' : (v.droppedPercent < 5 ? 'warn' : 'bad');
          return [v.label, text, cls];
        }));
        next();
      });
    });
  }

  function collectAutoplay(next) {
    setStatus('Autoplay mit Ton');
    var video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.src = '/clips/720p30-3M-high.mp4';
    video.volume = 0.05;
    var done = false;
    function finish(allowed, detail) {
      if (done) return;
      done = true;
      report.autoplay = { unmutedAllowed: allowed, detail: detail || null };
      video.pause();
      video.removeAttribute('src');
      addGroup('Autoplay', [['mit Ton erlaubt', allowed === null ? 'unbekannt' : (allowed ? 'ja' : 'nein'), allowed ? 'ok' : 'warn']]);
      next();
    }
    var promise = video.play();
    if (promise && promise.then) {
      promise.then(function () { finish(true); }, function (err) { finish(false, String(err)); });
    } else {
      setTimeout(function () { finish(!video.paused); }, 2000);
    }
    setTimeout(function () { finish(null, 'timeout'); }, 8000);
  }

  // --- Step: send report ----------------------------------------------------

  function sendReport(next) {
    report.finishedAt = new Date().toISOString();
    setStatus('Sende Bericht …');
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/report');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () {
      setStatus(xhr.status === 201 ? 'Fertig · Bericht gespeichert' : 'Fertig · Bericht NICHT gespeichert (HTTP ' + xhr.status + ')');
      next();
    };
    xhr.onerror = function () {
      setStatus('Fertig · Bericht NICHT gespeichert (Netzwerk)');
      next();
    };
    xhr.send(JSON.stringify(report));
  }

  function summarizeAnimation(next) {
    addGroup('Animation (5 s je Szene)', report.animation.map(function (a) {
      var cls = a.fps >= 50 ? 'ok' : (a.fps >= 30 ? 'warn' : 'bad');
      return [a.label, a.fps + ' fps · p95 ' + a.p95 + ' ms · ' + a.longFrames + ' lange', cls];
    }));
    next();
  }

  sequence([
    collectEnvironment,
    collectStorage,
    collectServiceWorker,
    collectCodecs,
    animationScene('transform-12', '12 Boxen transform', boxes(12, false)),
    animationScene('transform-shadow-12', '12 Boxen + box-shadow', boxes(12, true)),
    animationScene('crossfade', 'Vollbild-Überblendung (opacity)', crossfade),
    animationScene('backdrop-blur', 'backdrop-filter blur(7px)', glass),
    summarizeAnimation,
    collectVideo,
    collectAutoplay,
    sendReport
  ], function () {
    if (params.repeat) {
      // Optional soak test: ?repeat=30 reloads every 30 minutes.
      setTimeout(function () { location.reload(); }, Number(params.repeat) * 60000);
    }
  });
})();
