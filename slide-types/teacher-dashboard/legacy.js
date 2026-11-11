// Teacher dashboard, ported 1:1 from wp-foyer (public/js/teacher-dashboard.js).
// Changes against the original:
//   - the rows come from the Foyer server (already filtered to the slide's
//     teachers) instead of fetch(); the 30 s timer re-renders with the latest
//     rows so the "later today" colouring moves on,
//   - mount/update/unmount are exported instead of the MutationObserver.
/* eslint-disable */

// Controller for the WebUntis Teacher Dashboard slide – mirrors the standalone WebUntis dashboard behaviour.

const STATUS_KEYS = ['gone', 'nodata', 'irregular', 'none', 'cancelled'];
const STATUS_LABELS = {
	gone: 'Abwesend',
	nodata: 'Keine Daten',
	irregular: 'Unregelmäßig',
	none: 'Anwesend',
	cancelled: 'Entfällt'
};

function normalize(value) {
	return (value == null ? '' : String(value)).trim();
}

function lower(value) {
	return normalize(value).toLowerCase();
}

function toHHMM(csvDateTime) {
	const s = normalize(csvDateTime);
	const match = s.match(/\b(\d{1,2}):(\d{2})/);
	if (!match) {
		return '';
	}
	const hh = match[1].padStart(2, '0');
	const mm = match[2].padStart(2, '0');
	return hh + ':' + mm;
}

function parseCSVDate(csvDateTime) {
	const s = normalize(csvDateTime);
	if (!s) {
		return null;
	}

	let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
	if (m) {
		let [, a, b, y, h, mi, se] = m;
		a = parseInt(a, 10);
		b = parseInt(b, 10);
		const year = parseInt(y, 10) < 100 ? parseInt(y, 10) + 2000 : parseInt(y, 10);
		const hour = parseInt(h, 10);
		const minute = parseInt(mi, 10);
		const second = se ? parseInt(se, 10) : 0;

		let day;
		let month;
		if (a > 12 && b <= 12) {
			day = a;
			month = b - 1;
		} else if (b > 12 && a <= 12) {
			day = b;
			month = a - 1;
		} else {
			day = a;
			month = b - 1;
		}

		return new Date(year, month, day, hour, minute, second);
	}

	m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
	if (m) {
		let [, y, mo, d, h, mi, se] = m;
		return new Date(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(mi, 10), se ? parseInt(se, 10) : 0);
	}

	m = s.match(/^(\d{1,2})\.(\d{1,2})\.\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
	if (m) {
		const now = new Date();
		let [, d, mo, h, mi, se] = m;
		return new Date(now.getFullYear(), parseInt(mo, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(mi, 10), se ? parseInt(se, 10) : 0);
	}

	m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
	if (m) {
		const now = new Date();
		const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(m[1], 10), parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : 0);
		const diff = dt.getTime() - now.getTime();
		if (diff < -12 * 60 * 60 * 1000) {
			dt.setDate(dt.getDate() + 1);
		}
		return dt;
	}

	return null;
}

function isFarFuture(row) {
	const dt = parseCSVDate(row[1]);
	if (!dt) {
		return false;
	}
	return dt.getTime() - Date.now() > 45 * 60 * 1000;
}

function createTile() {
	const tile = document.createElement('div');
	tile.className = 'foyer-teacher-dashboard__tile tile';
	tile.setAttribute('role', 'listitem');
	tile.innerHTML = '' +
		'<div class="ln1"></div>' +
		'<div class="ln2"></div>' +
		'<div class="ln3"></div>' +
		'<div class="ln4"></div>' +
		'<div class="ln5"></div>';
	return tile;
}

// Text and tooltip of a tile line, changed only when they differ (no redraw otherwise).
function setLine(node, text) {
	if (node.textContent !== text) {
		node.textContent = text;
	}
	if (node.title !== text) {
		node.title = text;
	}
}

function applyEntryToTile(tile, row) {
	var clsMap = {
		gone: 'bg-gone',
		nodata: 'bg-nodata',
		irregular: 'bg-irregular',
		none: 'bg-none',
		cancelled: 'bg-cancelled'
	};

	var key = lower(row[7] || 'none');
	var baseClass = clsMap[key] || clsMap.none;
	var finalClass = baseClass;
	if (baseClass === 'bg-none' && isFarFuture(row)) {
		finalClass = 'bg-future';
	}

	var className = 'foyer-teacher-dashboard__tile tile ' + finalClass;
	if (tile.className !== className) {
		tile.className = className;
	}

	var ln1 = tile.querySelector('.ln1');
	var ln2 = tile.querySelector('.ln2');
	var ln3 = tile.querySelector('.ln3');
	var ln4 = tile.querySelector('.ln4');
	var ln5 = tile.querySelector('.ln5');

	if (ln1) {
		setLine(ln1, normalize(row[0]));
	}
	if (ln2) {
		const t1 = toHHMM(row[1]);
		const t2 = toHHMM(row[2]);
		setLine(ln2, t1 && t2 ? t1 + ' – ' + t2 : (t1 || t2 || ''));
	}
	if (ln3) {
		setLine(ln3, normalize(row[3]));
	}
	if (ln4) {
		setLine(ln4, normalize(row[5]));
	}
	if (ln5) {
		setLine(ln5, normalize(row[6]));
	}
}

function groupRowsByTeacher(rows) {
	const groups = new Map();
	rows.forEach(function(row){
		const teacher = normalize(row[0]);
		if (!groups.has(teacher)) {
			groups.set(teacher, []);
		}
		groups.get(teacher).push(row);
	});

	return Array.from(groups.entries());
}

function sortGroups(groups, collator) {
	return groups
		.map(function(entry){
			const teacher = entry[0];
			const rows = entry[1].slice().sort(function(a, b){
				const da = parseCSVDate(a[1]);
				const db = parseCSVDate(b[1]);
				const ta = da ? da.getTime() : 0;
				const tb = db ? db.getTime() : 0;
				if (ta === tb) {
					return collator.compare(normalize(a[0]), normalize(b[0]));
				}
				return ta - tb;
			});
			return { teacher: teacher, rows: rows };
		})
		.sort(function(a, b){
			return collator.compare(a.teacher, b.teacher);
		});
}

	function computeGrid(wrapper, grid, count) {
		if (!wrapper || !grid) {
			return;
		}
		// Use the rendered (possibly scaled) size when deciding how many columns we can fit.
		const wrapperRect = typeof wrapper.getBoundingClientRect === 'function' ? wrapper.getBoundingClientRect() : null;
		const gridRect = typeof grid.getBoundingClientRect === 'function' ? grid.getBoundingClientRect() : null;
		const w = (wrapperRect && wrapperRect.width) || (gridRect && gridRect.width) || wrapper.clientWidth || grid.clientWidth;
		const h = (wrapperRect && wrapperRect.height) || (gridRect && gridRect.height) || grid.clientHeight || wrapper.clientHeight;
		if (!w || !h) {
			return;
		}
		const gap = 12;
		const narrowBreakpoint = 768;
		let cols;
		const viewportWidth = typeof window !== 'undefined' ? Math.min(window.innerWidth || w, w) : w;
		const isPortrait = h > w;
		const twoColTileWidth = count > 1 ? (w - gap) / Math.min(2, count) : w;
		const shouldForceSingleColumn = count <= 2 && (
			viewportWidth < narrowBreakpoint ||
			w < narrowBreakpoint ||
			isPortrait ||
			twoColTileWidth < 520
		);
		if (shouldForceSingleColumn) {
			cols = 1;
		} else {
			cols = Math.max(1, Math.round(Math.sqrt(count * (w / h))));
		}
		cols = Math.min(cols, Math.max(1, count));
		const rows = Math.max(1, Math.ceil(count / cols));
		grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
		const tileW = (w - gap * (cols - 1)) / cols;
		const tileH = (h - gap * (rows - 1)) / rows;
		const base = Math.max(10, Math.min(tileW, tileH) * 0.068);
		wrapper.style.setProperty('--base-font', base + 'px');
	}

function initInstance(wrapper, payload) {
	if (!wrapper || wrapper.dataset.foyerTeacherDashboardInit === '1') {
		return;
	}
	wrapper.dataset.foyerTeacherDashboardInit = '1';

	const grid = wrapper.querySelector('.foyer-teacher-dashboard__grid');
	const legend = wrapper.querySelector('.foyer-teacher-dashboard__legend');
	const errorContainer = wrapper.querySelector('.foyer-teacher-dashboard__error');
	const errorMessage = wrapper.querySelector('.foyer-teacher-dashboard__error-msg');

	const noSourceMessage = normalize(wrapper.dataset.errorNoSource) || 'Keine Datenquelle definiert.';
	const refreshSec = Math.max(5, parseInt(wrapper.dataset.refresh || '30', 10) || 30);
	let teacherSet = new Set();
	try {
		const parsed = JSON.parse(wrapper.dataset.teachers || '[]');
		if (Array.isArray(parsed)) {
			teacherSet = new Set(parsed.map(normalize).filter(Boolean));
		}
	} catch (err) {
		teacherSet = new Set();
	}

	const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
	let rotateTimer = null;
	let refreshTimer = null;
	let lastRows = [];
	let lastViewKey = null;
	let stateGroups = [];
	let activeStatus = new Set();

	function passesTeacherFilter(row) {
		if (teacherSet.size === 0) {
			return true;
		}
		return teacherSet.has(normalize(row[0]));
	}

	function passesStatusFilter(row) {
		if (!activeStatus || activeStatus.size === 0) {
			return true;
		}
		const key = lower(row[7] || 'none');
		return activeStatus.has(key);
	}

	function stopRotation() {
		if (rotateTimer) {
			clearInterval(rotateTimer);
			rotateTimer = null;
		}
	}

	function startRotation() {
		stopRotation();
		rotateTimer = setInterval(function(){
			if (document.visibilityState && document.visibilityState !== 'visible') {
				return;
			}
			wrapper.querySelectorAll('.foyer-teacher-dashboard__tile[data-multi="1"]').forEach(function(tile){
				if (!tile._group) {
					return;
				}
				tile._index = (tile._index + 1) % tile._group.rows.length;
				applyEntryToTile(tile, tile._group.rows[tile._index]);
			});
		}, 2000);
	}

	function renderLegend(counts) {
		if (!legend) {
			return;
		}

		legend.innerHTML = '';

		STATUS_KEYS.forEach(function(key){
			var count = counts[key] || 0;
			var chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'foyer-teacher-dashboard__legend-chip';
			chip.dataset.status = key;
			if (activeStatus.size === 0 || activeStatus.has(key)) {
				chip.classList.add('is-active');
			}
			if (count === 0) {
				chip.disabled = true;
				chip.classList.add('is-disabled');
			}

			var swatch = document.createElement('span');
			swatch.className = 'foyer-teacher-dashboard__legend-swatch';
			chip.appendChild(swatch);

			var label = document.createElement('span');
			label.textContent = STATUS_LABELS[key] || key;
			chip.appendChild(label);

			var badge = document.createElement('span');
			badge.className = 'foyer-teacher-dashboard__legend-count';
			badge.textContent = String(count);
			chip.appendChild(badge);

			if (!chip.disabled) {
				chip.addEventListener('click', function(){
					if (activeStatus.has(key)) {
						activeStatus.delete(key);
					} else {
						activeStatus.add(key);
					}
					var allOn = STATUS_KEYS.every(function(k){ return activeStatus.has(k); });
					if (allOn || activeStatus.size === 0) {
						activeStatus = new Set();
					}
					render(lastRows);
				});
			}

			legend.appendChild(chip);
		});
	}

	function showError(message) {
		if (errorMessage) {
			errorMessage.textContent = message;
		}
		if (errorContainer) {
			errorContainer.hidden = false;
		}
	}

	function hideError() {
		if (errorContainer && !errorContainer.hidden) {
			errorContainer.hidden = true;
		}
	}

	function render(rows) {
		lastRows = rows;

		var baseRows = rows.filter(passesTeacherFilter);
		// Same picture as last time (the 30 s timer, unchanged data): leave the page
		// alone. Every redraw costs graphics memory on Airtame that is not given back.
		var viewKey = JSON.stringify([baseRows, baseRows.map(isFarFuture), Array.from(activeStatus)]);
		if (viewKey === lastViewKey) {
			return;
		}
		lastViewKey = viewKey;
		var counts = {};
		STATUS_KEYS.forEach(function(key){ counts[key] = 0; });
		baseRows.forEach(function(r){
			var k = lower(r[7] || 'none');
			if (!counts.hasOwnProperty(k)) {
				counts[k] = 0;
			}
			counts[k] += 1;
		});
		renderLegend(counts);

		const filtered = baseRows.filter(passesStatusFilter);
		const groups = sortGroups(groupRowsByTeacher(filtered), collator);
		stateGroups = groups;

		if (grid) {
			grid.innerHTML = '';
		}

		stopRotation();

		groups.forEach(function(group){
			const tile = createTile();
			tile._group = group;
			tile._index = 0;
			applyEntryToTile(tile, group.rows[0]);
			if (group.rows.length > 1) {
				tile.dataset.multi = '1';
			}
			if (grid) {
				grid.appendChild(tile);
			}
		});

			const count = Math.max(1, groups.length);
			if (grid) {
				grid.dataset.foyerTileGroups = count <= 2 ? 'few' : 'many';
			}
			computeGrid(wrapper, grid, count);
		startRotation();
	}

	function fetchAndRender() {
		if (payload.noSource) {
			showError(noSourceMessage);
			return;
		}
		if (payload.error) {
			showError(payload.error);
			return;
		}
		hideError();
		render((payload.rows || []).filter(function(parts){ return parts.length >= 8; }));
	}

	const resizeHandler = function(){
		computeGrid(wrapper, grid, Math.max(1, stateGroups.length));
	};

	window.addEventListener('resize', resizeHandler);

	refreshTimer = setInterval(function(){
		if (document.visibilityState && document.visibilityState !== 'visible') {
			return;
		}
		fetchAndRender();
	}, refreshSec * 1000);

	wrapper._foyerTeacherDashboardUpdate = function(next){
		payload = next || {};
		fetchAndRender();
	};

	wrapper._foyerTeacherDashboardCleanup = function(){
		stopRotation();
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
		window.removeEventListener('resize', resizeHandler);
		delete wrapper.dataset.foyerTeacherDashboardInit;
		delete wrapper._foyerTeacherDashboardUpdate;
	};

	fetchAndRender();
}

export function mount(wrapper, payload) {
	initInstance(wrapper, payload || {});
}

// New rows from the server: re-render right away.
export function update(wrapper, payload) {
	if (wrapper._foyerTeacherDashboardUpdate) {
		wrapper._foyerTeacherDashboardUpdate(payload);
	}
}

export function unmount(wrapper) {
	if (wrapper._foyerTeacherDashboardCleanup) {
		wrapper._foyerTeacherDashboardCleanup();
	}
}
