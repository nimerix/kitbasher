import { keyActions, keyGroups } from '../core/keybindings';
import { assemblyGuides } from './assembly-guides';
import { startGuides } from './start-guides';
import { workspaceGuides } from './workspace-guides';
import type { DocArticle, DocGroup } from './types';

export const groups: DocGroup[] = [
  'Start here',
  'Build & assemble',
  'Inspect & finish',
  'Workspace & files',
  'Beyond the desktop',
];

const shortcuts: DocArticle = {
  id: 'keyboard-shortcuts',
  title: 'Keyboard shortcuts',
  group: 'Workspace & files',
  icon: 'keyboard',
  description: 'Every default shortcut, plus pointer gestures and ways to customize your controls.',
  intro:
    'Keep your hands on the model. These are the default bindings shipped with Kitbasher; the workbench help and tooltips always reflect your own custom bindings.',
  image: {
    src: './images/preferences.webp',
    alt: 'Kitbasher keyboard preferences with remappable tool and camera shortcuts.',
    caption: 'Preferences → Keyboard lets you assign keys to the actions you use most.',
  },
  sections: [
    {
      id: 'using-shortcuts',
      title: 'Reading this reference',
      paragraphs: [
        'Mod means Command on macOS and Ctrl on Windows or Linux. Most shortcuts are active when you are not typing into a text or numeric field. Save and Open also work while editing a field; the workbench finishes that field edit first. Your browser or operating system may reserve some key combinations.',
        'Open Preferences → Keyboard to add or remove a binding. Assigning a key already used by another action transfers that key to the new action. Use the reset controls to return to the defaults.',
      ],
    },
    ...keyGroups.map((group) => ({
      id: group.toLowerCase(),
      title: group,
      table: {
        headers: ['Action', 'Default keys'],
        rows: Object.values(keyActions)
          .filter((action) => action.group === group)
          .map((action) => [action.label, action.keys.join(' / ')]),
      },
    })),
    {
      id: 'pointer-gestures',
      title: 'Pointer gestures',
      table: {
        headers: ['Gesture', 'Action'],
        rows: [
          ['Click / Shift-click', 'Select a part / add or remove a part from the selection'],
          [
            'Middle-drag / Space + left-drag',
            'Orbit, including while picking alignment points or painting',
          ],
          ['Right-drag', 'Pan the view'],
          ['Wheel / pinch', 'Zoom'],
          ['Shift during a gizmo drag', 'One-tenth sensitivity without starting a new undo step'],
          ['Alt during surface painting', 'Erase the painted patch'],
          ['Right-click while painting', 'Open the contextual brush settings'],
          ['One finger / two fingers on touch', 'Active camera mode / pan and zoom'],
        ],
      },
    },
    {
      id: 'free-placement',
      title: 'Free pointer placement',
      paragraphs: [
        'Shift+G starts free move and Shift+R starts free rotate without grabbing a handle. X, Y, or Z constrains the operation in the handle frame. Enter or left-click confirms; Escape or right-click cancels. A confirmed placement is one undo step.',
      ],
    },
  ],
  related: ['preferences', 'navigation', 'transforms'],
};

const order = [
  'introduction',
  'quick-start',
  'interface',
  'importing',
  'navigation',
  'workflows',
  'troubleshooting',
  'parts',
  'transforms',
  'alignment',
  'contact-paint',
  'flush-fit',
  'anchors',
  'joints',
  'planes',
  'no-clip',
  'measurement',
  'inspection',
  'performance',
  'export',
  'saving',
  'google-drive',
  'display',
  'preferences',
  'keyboard-shortcuts',
  'headset',
  'automation',
];
export const articles: DocArticle[] = [
  ...startGuides,
  ...assemblyGuides,
  ...workspaceGuides,
  shortcuts,
].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
export const articleById = new Map(articles.map((article) => [article.id, article]));

export function searchDocs(query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return articles
    .map((article) => {
      const title = article.title.toLowerCase();
      const description = `${article.description} ${article.intro}`.toLowerCase();
      const body = JSON.stringify(article.sections).toLowerCase();
      const score = terms.every((term) => `${title} ${description} ${body}`.includes(term))
        ? terms.reduce(
            (sum, term) => sum + (title.includes(term) ? 12 : description.includes(term) ? 5 : 1),
            0,
          )
        : 0;
      const section = article.sections.find((item) =>
        terms.some((term) => JSON.stringify(item).toLowerCase().includes(term)),
      );
      return {
        article,
        score,
        snippet: section?.paragraphs?.[0] ?? section?.steps?.[0] ?? article.description,
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);
}
