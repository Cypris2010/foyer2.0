// Room display, data logic ported from wp-foyer (public/js/webuntis-room-display.js).
// Changes against the original:
//   - the data comes from the Foyer server (rows of the Untis export, already
//     filtered to the slide's rooms) instead of fetch(); the refresh timer
//     re-renders with the latest data so "current" and "upcoming" move on,
//   - mount/update/unmount are exported instead of the MutationObserver,
//   - the parser reads rows instead of splitting the text,
//   - tiles.ts draws the rooms instead of the cards,
//   - rooms that show the same bookings share one card or tile (same-booking.ts).
/* eslint-disable */
import { renderTiles, shownUpcoming } from './tiles.ts';
import { mergeSameBookings } from './same-booking.ts';


// Track per-node runtime state so timers can be cleaned up.
var instances = new WeakMap();
// Treat back-to-back lessons with up to five minutes gap as one block.
var MERGE_GAP_MS = 5 * 60 * 1000;

// Safely parse JSON stored in data attributes and fall back to an empty list.
function parseJsonAttribute(value) {
	if (!value) {
		return [];
	}
	try {
		var parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch (err) {
		return [];
	}
}

// Normalise room labels to make comparisons whitespace-insensitive.
function normaliseRoom(value) {
	return (value || '').replace(/\s+/g, ' ').trim();
}

// Detect generic lesson markers that should not be surfaced as remarks.
function isGenericLessonType(value) {
	return (value || '').trim().toLowerCase() === 'unterricht';
}

function normaliseDetail(value) {
	return (value || '').replace(/\s+/g, ' ').trim();
}

function normaliseSignature(value) {
	var detail = normaliseDetail(value).toLowerCase();
	if (!detail) {
		return '';
	}
	return detail.replace(/[^a-z0-9]/g, '');
}

function collectSignatureTokens(value) {
	var trimmed = normaliseDetail(value);
	if (!trimmed) {
		return [];
	}
	var prepared = trimmed.replace(/[,;•/&]+/g, ' ');
	var rough = prepared.split(/\s+/);
	var tokens = [];
	for (var i = 0; i < rough.length; i++) {
		var current = normaliseSignature(rough[i]);
		if (!current) {
			continue;
		}
		var next = null;
		if (i + 1 < rough.length) {
			next = normaliseSignature(rough[i + 1]);
			if (!next) {
				next = null;
			}
		}
		var shouldCombine = false;
		if (next) {
			if (/^[0-9]+$/.test(current) && /^[a-z]+$/.test(next)) {
				shouldCombine = true;
			} else if (/^[a-z]+$/.test(current) && /^[0-9]+$/.test(next)) {
				shouldCombine = true;
			}
		}
		if (shouldCombine) {
			tokens.push(current + next);
			i++;
			continue;
		}
		tokens.push(current);
	}
	var unique = [];
	for (var j = 0; j < tokens.length; j++) {
		if (unique.indexOf(tokens[j]) === -1) {
			unique.push(tokens[j]);
		}
	}
	unique.sort();
	return unique;
}

function normaliseListSignature(value) {
	var tokens = collectSignatureTokens(value);
	return tokens.join('|');
}

function ensureCommaSpacing(value) {
	if (!value) {
		return '';
	}
	return value.replace(/,\s*/g, ', ').trim();
}

function buildMergeKey(entry) {
	return [
		entry ? normaliseRoom(entry.room) : '',
		normaliseListSignature(entry ? entry.teachers : ''),
		normaliseListSignature(entry ? entry.classes : ''),
		normaliseSignature(entry ? entry.subject : '')
	].join('||');
}

// Convert the WebUntis timestamp format into a Date object.
function parseDate(raw) {
	if (!raw || raw === '-' ) {
		return null;
	}
	var normalised = String(raw).trim().replace(' ', 'T');
	var date = new Date(normalised);
	return isNaN(date.getTime()) ? null : date;
}

// Format a single clock time in the configured locale/timezone;
// fall back to a manual formatter if Intl fails (e.g. on old browsers).
function formatTime(date, locale, timezone) {
	try {
		return new Intl.DateTimeFormat(locale || undefined, {
			hour: '2-digit',
			minute: '2-digit',
			timeZone: timezone || undefined,
			hour12: false
		}).format(date);
	} catch (err) {
		var hours = date.getHours();
		var minutes = date.getMinutes();
		return (hours < 10 ? '0' + hours : '' + hours) + ':' + (minutes < 10 ? '0' + minutes : '' + minutes);
	}
}

// Render a human readable time span such as "08:00 – 09:30".
function formatTimeRange(start, end, locale, timezone) {
	if (!start || !end) {
		return '';
	}
	return formatTime(start, locale, timezone) + ' – ' + formatTime(end, locale, timezone);
}

// Determine whether two consecutive events should be merged into one block.
function shouldMerge(prev, next) {
	if (!prev || !next) {
		return false;
	}
	if (prev.room !== next.room) {
		return false;
	}
	if (normaliseListSignature(prev.teachers) !== normaliseListSignature(next.teachers)) {
		return false;
	}
	if (normaliseListSignature(prev.classes) !== normaliseListSignature(next.classes)) {
		return false;
	}
	if (normaliseSignature(prev.subject) !== normaliseSignature(next.subject)) {
		return false;
	}
	var prevEnd = prev.endDate ? prev.endDate.getTime() : null;
	var nextStart = next.startDate ? next.startDate.getTime() : null;
	if (prevEnd === null || nextStart === null) {
		return false;
	}
	if (nextStart <= prevEnd) {
		return true;
	}
	return (nextStart - prevEnd) <= MERGE_GAP_MS;
}

// Merge adjacent entries that belong together so the display stays compact.
function mergeEntries(entries) {
	if (!entries.length) {
		return entries;
	}
	entries.sort(function (a, b) {
		if (a.startDate.getTime() !== b.startDate.getTime()) {
			return a.startDate.getTime() - b.startDate.getTime();
		}
		return a.endDate.getTime() - b.endDate.getTime();
	});
	var result = [];
	var lastByKey = new Map();
	for (var i = 0; i < entries.length; i++) {
		var current = entries[i];
		var key = buildMergeKey(current);
		var previous = lastByKey.get(key) || null;
		if (!previous) {
			result.push(current);
			lastByKey.set(key, current);
			continue;
		}
		if (shouldMerge(previous, current)) {
			if (current.startDate.getTime() < previous.startDate.getTime()) {
				previous.startRaw = current.startRaw;
				previous.startDate = current.startDate;
			}
			if (current.endDate.getTime() > previous.endDate.getTime()) {
				previous.endRaw = current.endRaw;
				previous.endDate = current.endDate;
			}
			previous.type = mergeText(previous.type, current.type);
			previous.textSubstitute = mergeText(previous.textSubstitute, current.textSubstitute);
			previous.textBooking = mergeText(previous.textBooking, current.textBooking);
			previous.title = mergeText(previous.title, current.title);
			previous.cancelled = !!(previous.cancelled || current.cancelled);
			lastByKey.set(key, previous);
		} else {
			result.push(current);
			lastByKey.set(key, current);
		}
	}
	return result;
}

function mergeText(first, second) {
	var primary = normaliseDetail(first);
	var secondary = normaliseDetail(second);
	if (!primary) {
		return secondary ? second : first;
	}
	if (!secondary) {
		return first;
	}
	var lowerPrimary = primary.toLowerCase();
	var lowerSecondary = secondary.toLowerCase();
	if (lowerSecondary && lowerPrimary.indexOf(lowerSecondary) !== -1) {
		return first;
	}
	return first + ' • ' + second;
}

// Parse the raw WebUntis export (pipe-separated text) into structured events.
function parseUntis(rows) {
	var entries = [];

	for (var i = 0; i < rows.length; i++) {
		var parts = rows[i];
		if (!parts || !parts.length) {
			continue;
		}
		var roomOriginal = parts[0] ? parts[0].trim() : '';
		var room = normaliseRoom(roomOriginal);
		if (!room) {
			continue;
		}

		var statusRaw = parts[7] ? parts[7].trim() : '';
		var statusNormalised = statusRaw.toLowerCase();
		var isCancelled = statusNormalised === 'cancelled' || statusNormalised === 'gone';

		var startRaw = parts[1] ? parts[1].trim() : '';
		var endRaw = parts[2] ? parts[2].trim() : '';
		var startDate = parseDate(startRaw);
		var endDate = parseDate(endRaw);
		if (!startDate || !endDate) {
			continue;
		}

		var roomsDetail = parts[3] ? parts[3].trim() : '';
		var teachersDetail = parts[4] ? parts[4].trim() : '';
		var classesDetail = ensureCommaSpacing(parts[5] ? parts[5].trim() : '');
		var subjectDetail = parts[6] ? parts[6].trim() : '';
		var typeDetail = parts[8] ? parts[8].trim() : '';
		var textSubstitute = parts[9] ? parts[9].trim() : '';
		var textBooking = parts[10] ? parts[10].trim() : '';
		var titleDetail = [subjectDetail, classesDetail].filter(Boolean).join(' • ');

		entries.push({
			roomOriginal: roomOriginal || room,
			room: room,
			startRaw: startRaw,
			endRaw: endRaw,
			startDate: startDate,
			endDate: endDate,
			rooms: roomsDetail,
			teachers: teachersDetail,
			classes: classesDetail,
			subject: subjectDetail,
			title: titleDetail,
			status: statusRaw,
			type: typeDetail,
			textSubstitute: textSubstitute,
			textBooking: textBooking,
			cancelled: isCancelled
		});
	}

	return mergeEntries(entries);
}

// Group parsed entries by the requested rooms and compute current/upcoming events.
function buildRoomData(entries, requested) {
	var now = new Date();
	var byRoom = new Map();
	var order = [];

	for (var i = 0; i < requested.length; i++) {
		var displayName = requested[i];
		var key = normaliseRoom(displayName);
		if (!key) {
			continue;
		}
		if (!byRoom.has(key)) {
			byRoom.set(key, []);
			order.push({ key: key, display: displayName });
		}
	}

	for (var j = 0; j < entries.length; j++) {
		var entry = entries[j];
		if (entry.endDate.getTime() <= now.getTime()) {
			continue;
		}
		if (!byRoom.has(entry.room)) {
			continue;
		}
		byRoom.get(entry.room).push(entry);
	}

	var result = [];
	for (var k = 0; k < order.length; k++) {
		var descriptor = order[k];
		var list = byRoom.get(descriptor.key) || [];
		list.sort(function (a, b) {
			if (a.startDate.getTime() !== b.startDate.getTime()) {
				return a.startDate.getTime() - b.startDate.getTime();
			}
			return a.endDate.getTime() - b.endDate.getTime();
		});
		var current = [];
		var upcoming = [];
		var nowTime = now.getTime();

		for (var idx = 0; idx < list.length; idx++) {
			var item = list[idx];
			var startTime = item.startDate.getTime();
			var endTime = item.endDate.getTime();
			if (startTime <= nowTime && endTime > nowTime) {
				current.push(item);
			} else if (startTime > nowTime) {
				upcoming.push(item);
			}
		}

		result.push({
			room: descriptor.display,
			key: descriptor.key,
			current: current,
			upcoming: upcoming
		});
	}

	return result;
}

// Remove every child node so the grid can be rebuilt from scratch.
function clearChildren(node) {
	while (node.firstChild) {
		node.removeChild(node.firstChild);
	}
}

// Update the "last refreshed" badge that sits in each column header.
function updateTimestamp(node, labels, locale, timezone, timestamp) {
	var updatedNode = node.querySelector('.foyer-webuntis-room-display__updated');
	if (!updatedNode || !timestamp) {
		return;
	}
	var formattedTime = formatTime(timestamp, locale, timezone);
	if (labels.updated && labels.updated.indexOf('%s') !== -1) {
		updatedNode.textContent = labels.updated.replace('%s', formattedTime);
	} else if (labels.updated) {
		updatedNode.textContent = labels.updated + ' ' + formattedTime;
	} else {
		updatedNode.textContent = formattedTime;
	}
}

// Manual zero-padding helper for fallback formatters.
function pad(number) {
	return number < 10 ? '0' + number : String(number);
}

// Format a calendar date using Intl if available, otherwise fall back to DD.MM.YYYY.
function formatDate(date, locale, timezone) {
	try {
		return new Intl.DateTimeFormat(locale || undefined, {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			timeZone: timezone || undefined
		}).format(date);
	} catch (err) {
		return pad(date.getDate()) + '.' + pad(date.getMonth() + 1) + '.' + date.getFullYear();
	}
}

// Format a time string (HH:MM) for the live clock shown on the widget.
function formatClockTime(date, locale, timezone) {
	try {
		return new Intl.DateTimeFormat(locale || undefined, {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			timeZone: timezone || undefined
		}).format(date);
	} catch (err) {
		return pad(date.getHours()) + ':' + pad(date.getMinutes());
	}
}

// Kick off the live clock displayed above the schedule.
function startClock(node, state) {
	var container = node.querySelector('.foyer-webuntis-room-display__clock');
	if (!container) {
		return;
	}
	if (state.clockTimer) {
		clearTimeout(state.clockTimer);
		state.clockTimer = null;
	}

	var dateNode = container.querySelector('.foyer-webuntis-room-display__clock-date');
	var timeNode = container.querySelector('.foyer-webuntis-room-display__clock-time');

	var formatDateAttr = container.getAttribute('data-format-date');
	var formatTimeAttr = container.getAttribute('data-format-time');

	function applyFormats(now) {
		if (dateNode) {
			if (formatDateAttr) {
				dateNode.textContent = formatCustom(now, formatDateAttr, state.timezone);
			} else {
				dateNode.textContent = formatDate(now, state.locale, state.timezone);
			}
		}
		if (timeNode) {
			if (formatTimeAttr) {
				timeNode.textContent = formatCustom(now, formatTimeAttr, state.timezone);
			} else {
				timeNode.textContent = formatClockTime(now, state.locale, state.timezone);
			}
		}
	}

	function schedule() {
		var now = new Date();
		applyFormats(now);
		var delay = 60000 - ((now.getSeconds() * 1000) + now.getMilliseconds());
		state.clockTimer = setTimeout(schedule, delay > 0 ? delay : 60000);
	}

	schedule();
}

// Interpret a small custom formatting syntax (Y, m, d, H, i, ...).
function formatCustom(date, pattern, timezone) {
	var components = dateWithZone(date, timezone);
	var replacements = {
		'Y': String(components.year),
		'y': String(components.year).slice(-2),
		'm': pad(components.month),
		'n': String(components.month),
		'd': pad(components.day),
		'j': String(components.day),
		'H': pad(components.hour),
		'G': String(components.hour),
		'i': pad(components.minute)
	};

	return pattern.replace(/Y|y|m|n|d|j|H|G|i/g, function (token) {
		return replacements[token] !== undefined ? replacements[token] : token;
	});
}

// Read date components for a specific timezone, falling back to local time.
function dateWithZone(date, timezone) {
	var fallback = {
		year: date.getFullYear(),
		month: date.getMonth() + 1,
		day: date.getDate(),
		hour: date.getHours(),
		minute: date.getMinutes()
	};

	if (!timezone || !Intl || !Intl.DateTimeFormat) {
		return fallback;
	}
	try {
		var parts = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).formatToParts(date);
		var values = {};
		for (var i = 0; i < parts.length; i++) {
			values[parts[i].type] = parts[i].value;
		}

		return {
			year: values.year ? Number(values.year) : fallback.year,
			month: values.month ? Number(values.month) : fallback.month,
			day: values.day ? Number(values.day) : fallback.day,
			hour: values.hour ? Number(values.hour) : fallback.hour,
			minute: values.minute ? Number(values.minute) : fallback.minute
		};
	} catch (err) {
		return fallback;
	}
}

// Rebuild the tiles for the requested rooms based on the latest data.
function render(node, rooms, state) {
	var grid = node.querySelector('.foyer-webuntis-room-display__grid');
	if (!grid) {
		return;
	}

	clearChildren(grid);

	if (!rooms.length) {
		var placeholder = document.createElement('div');
		placeholder.className = 'foyer-webuntis-room-display__placeholder';
		placeholder.textContent = state.labels.noRooms;
		grid.appendChild(placeholder);
		return;
	}

	renderTiles(grid, rooms, state.labels, {
		formatRange: function (start, end) {
			return formatTimeRange(start, end, state.locale, state.timezone);
		},
		isGenericType: isGenericLessonType
	}, state.rooms.length, state.hideUpcoming);
}

// Show an inline error message inside the widget.
function setError(node, message) {
	var errorBox = node.querySelector('.foyer-webuntis-room-display__error');
	if (!errorBox) {
		return;
	}
	errorBox.textContent = message;
	errorBox.hidden = false;
}

// Hide the error area so the normal content can be shown.
function clearError(node) {
	var errorBox = node.querySelector('.foyer-webuntis-room-display__error');
	if (!errorBox) {
		return;
	}
	errorBox.hidden = true;
	errorBox.textContent = '';
}

// Cancel timers when an instance is torn down.
function cleanupInstance(state) {
	if (!state) {
		return;
	}
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = null;
	}
	if (state.clockTimer) {
		clearTimeout(state.clockTimer);
		state.clockTimer = null;
	}
}

// Render the rows the server delivered and schedule the next re-render.
function renderPayload(node, state) {
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = null;
	}

	var payload = state.payload || {};
	if (payload.error) {
		setError(node, state.labels.error + ' (' + payload.error + ')');
	} else {
		clearError(node);
		var entries = parseUntis(payload.rows || []);
		var rooms = mergeSameBookings(buildRoomData(entries, state.rooms), function (upcoming) {
			return shownUpcoming(upcoming, state.rooms.length, state.hideUpcoming);
		});

		var parsedLastModified = null;
		if (payload.lastModified) {
			var headerDate = new Date(payload.lastModified);
			if (!isNaN(headerDate.getTime())) {
				parsedLastModified = headerDate;
			}
		}
		if (!parsedLastModified) {
			parsedLastModified = new Date();
		}
		state.lastUpdated = parsedLastModified;

		render(node, rooms, state);
		startClock(node, state);
		updateTimestamp(node, state.labels, state.locale, state.timezone, state.lastUpdated);
	}

	if (state.refresh > 0) {
		state.timer = setTimeout(function () {
			renderPayload(node, state);
		}, state.refresh * 1000);
	}
}

// Initialise a widget node and render the delivered data.
function initInstance(node, payload) {
	if (instances.has(node)) {
		return;
	}

	var rooms = parseJsonAttribute(node.getAttribute('data-rooms')).map(function (room) {
		return String(room || '').trim();
	}).filter(Boolean);
	var uniqueRooms = [];
	rooms.forEach(function (room) {
		if (uniqueRooms.indexOf(room) === -1) {
			uniqueRooms.push(room);
		}
	});
	rooms = uniqueRooms;

	var refresh = parseInt(node.getAttribute('data-refresh'), 10);
	if (!(refresh > 0)) {
		refresh = 60;
	}
	if (refresh < 15) {
		refresh = 15;
	}

	var labels = {
		free: node.getAttribute('data-label-free') || 'Frei',
		occupied: node.getAttribute('data-label-occupied') || 'Belegt',
		noUpcoming: node.getAttribute('data-label-no-upcoming') || 'Keine weiteren Belegungen heute.',
		updated: node.getAttribute('data-label-updated') || 'Aktualisiert um %s',
		next: node.getAttribute('data-label-next') || 'Danach',
		cancelled: node.getAttribute('data-label-cancelled') || 'Unterricht entfällt',
		error: node.getAttribute('data-error-message') || 'Daten konnten nicht geladen werden.',
		noRooms: node.getAttribute('data-error-no-rooms') || 'Bitte wählen Sie mindestens einen Raum aus.'
	};

	var state = {
		payload: payload,
		rooms: rooms,
		refresh: refresh,
		locale: node.getAttribute('data-locale') || undefined,
		timezone: node.getAttribute('data-timezone') || undefined,
		labels: labels,
		timer: null,
		lastUpdated: null,
		clockTimer: null,
		hideUpcoming: node.getAttribute('data-hide-upcoming') === '1'
	};

	instances.set(node, state);
	startClock(node, state);

	if (!rooms.length) {
		var grid = node.querySelector('.foyer-webuntis-room-display__grid');
		if (grid) {
			clearChildren(grid);
			var placeholder = document.createElement('div');
			placeholder.className = 'foyer-webuntis-room-display__placeholder';
			placeholder.textContent = labels.noRooms;
			grid.appendChild(placeholder);
		}
		return;
	}

	renderPayload(node, state);
}

// Tear down a widget instance when it leaves the DOM.
function destroyInstance(node) {
	var state = instances.get(node);
	if (!state) {
		return;
	}
	cleanupInstance(state);
	instances.delete(node);
}

export function mount(node, payload) {
	initInstance(node, payload);
}

// New data from the server: re-render right away.
export function update(node, payload) {
	var state = instances.get(node);
	if (!state) {
		return;
	}
	state.payload = payload;
	if (state.rooms.length) {
		renderPayload(node, state);
	}
}

export function unmount(node) {
	destroyInstance(node);
}
