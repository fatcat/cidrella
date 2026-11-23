// The Analytics page's sections, in menu order. The page renders the menu
// from this list, and utils/member-ui.js reads it for which of them a member
// shows and what a hidden one is called.
export const ANALYTICS_SECTIONS = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: 'pi pi-objects-column',
    dataTrack: 'ana-tab-dashboard',
  },
  {
    id: 'performance',
    label: 'Performance',
    icon: 'pi pi-chart-bar',
    dataTrack: 'ana-tab-performance',
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    icon: 'pi pi-microchip-ai',
    dataTrack: 'ana-tab-intelligence',
  },
  {
    id: 'anomalies',
    label: 'Anomalies',
    icon: 'pi pi-exclamation-triangle',
    dataTrack: 'ana-tab-anomalies',
  },
  {
    id: 'map',
    label: 'Resolution Map',
    icon: 'pi pi-globe',
    dataTrack: 'ana-tab-map',
  },
];
