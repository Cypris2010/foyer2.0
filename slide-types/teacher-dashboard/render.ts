import { defineRenderer } from '@foyer/slide-sdk';
import type { TeacherDashboardConfig, TeacherDashboardData } from './index.ts';
import { mount, unmount, update } from './legacy.js';

// Markup of the wp-foyer template (teacher-dashboard.php).
export default defineRenderer<TeacherDashboardConfig, TeacherDashboardData>((root, { config, data }) => {
  root.classList.add('foyer-slide-teacher-dashboard');
  const wrapper = document.createElement('div');
  wrapper.className = `foyer-teacher-dashboard foyer-teacher-dashboard--${config.theme}`;
  wrapper.setAttribute('data-refresh', '30');
  wrapper.setAttribute('data-teachers', JSON.stringify(config.teachers));
  wrapper.setAttribute('data-error-no-source', 'Keine Datenquelle definiert.');
  wrapper.setAttribute('data-theme', config.theme);
  wrapper.innerHTML = `
    <div class="foyer-teacher-dashboard__grid" role="list"></div>
    ${config.legend ? '<div class="foyer-teacher-dashboard__legend" role="group" aria-label="Statusfilter"></div>' : ''}
    <div class="foyer-teacher-dashboard__error" hidden>
      <div class="foyer-teacher-dashboard__error-box" role="alert">
        <h3>CSV konnte nicht geladen werden</h3>
        <p class="foyer-teacher-dashboard__error-msg"></p>
      </div>
    </div>`;
  root.appendChild(wrapper);
  mount(wrapper, data);

  return {
    update(next) {
      update(wrapper, next as TeacherDashboardData);
    },
    destroy() {
      unmount(wrapper);
    },
  };
});
