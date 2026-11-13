import {
  CanvasTexture,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { Tool } from '../core/types';
import { facing } from '../core/xr';
import { xrAxisActions, xrButtonActions, xrButtonLabels, xrButtons } from '../core/xr-input';
import type { XRButton, XRInputSettings } from '../core/xr-input';
import { xrToolChoices } from './editor-tools';
import type { XRToolAction } from './editor-tools';

export type PanelPage = 'tools' | 'tool' | 'view' | 'bindings' | 'world';
export type PanelAction =
  | 'noop'
  | 'undo'
  | 'redo'
  | 'zoomIn'
  | 'zoomOut'
  | 'turnLeft'
  | 'turnRight'
  | 'focusSelection'
  | 'previousView'
  | 'trueSize'
  | 'reset'
  | 'clip'
  | 'level'
  | 'exit'
  | 'precision'
  | 'multiSelect'
  | 'axis'
  | `page:${PanelPage}`
  | `tool:${Tool}`
  | `edit:${XRToolAction}`
  | `bind:button:${XRButton}`
  | 'bind:axis:left'
  | 'bind:axis:right'
  | 'bind:zoomSpeed'
  | 'bind:turnAngle'
  | 'bind:triggerWorld'
  | 'bind:dominantHand'
  | 'bind:reset';

export interface PanelState {
  name: string;
  scale: string;
  canUndo: boolean;
  canRedo: boolean;
  canFocusSelection: boolean;
  canRestoreView: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  clip: boolean;
  level: boolean;
  status: string;
  stats: string;
  tool: Tool;
  toolStatus: string;
  toolButtons: { action: XRToolAction; label: string; enabled: boolean; on?: boolean }[];
  precision: boolean;
  multiSelect: boolean;
  axis: string;
  hints: string[];
  inputSettings: XRInputSettings;
}

interface Button {
  action: PanelAction;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  detail?: string;
  enabled: boolean;
  on?: boolean;
  selected?: boolean;
}

export interface PanelHit {
  /** Meters along the ray. */
  distance: number;
  /** In the room. */
  point: Vector3;
  action: PanelAction | null;
}

const width = 840,
  height = 884,
  density = 3000,
  margin = 40;
const inner = width - margin * 2,
  half = (inner - 16) / 2;
const font = '"Inter Variable", Inter, system-ui, sans-serif';
const colors = {
  panel: '#202226',
  raised: '#2c2f35',
  hover: '#3b4048',
  border: '#3a3e45',
  text: '#e9eaec',
  muted: '#959aa3',
  faint: '#5d626b',
  accent: '#ed9b54',
  ink: '#1b1d20',
};

/** Room-mounted editor controls, operated by either controller's ray. */
export class Panel {
  readonly object: Mesh<PlaneGeometry, MeshBasicMaterial>;
  hovered: PanelAction | null = null;
  pressed: PanelAction | null = null;
  page: PanelPage = 'view';
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly inverse = new Matrix4();
  private buttons: Button[] = [];
  private drawn = '';

  constructor() {
    this.canvas.width = width;
    this.canvas.height = height;
    this.context = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.object = new Mesh(
      new PlaneGeometry(width / density, height / density),
      new MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        side: DoubleSide,
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.object.renderOrder = 10;
    void document.fonts?.ready.then(() => {
      this.drawn = '';
    });
  }

  /** Hangs the panel within reach, to the lower left of the viewer. */
  place(head: Matrix4) {
    const { position, forward } = facing(head);
    const left = new Vector3(0, 1, 0).cross(forward);
    this.object.position
      .copy(position)
      .addScaledVector(forward, 0.5)
      .addScaledVector(left, 0.34)
      .add(new Vector3(0, -0.2, 0));
    this.object.quaternion.setFromRotationMatrix(
      this.inverse.lookAt(position, this.object.position, this.object.up),
    );
    this.object.updateMatrix();
  }

  navigate(action: PanelAction) {
    if (!action.startsWith('page:')) return false;
    this.page = action.slice(5) as PanelPage;
    this.hovered = this.pressed = null;
    return true;
  }

  update(state: PanelState) {
    const key = JSON.stringify([state, this.page, this.hovered, this.pressed]);
    if (key === this.drawn) return;
    this.drawn = key;
    this.draw(state);
    this.texture.needsUpdate = true;
  }

  hit(origin: Vector3, direction: Vector3): PanelHit | null {
    if (!this.object.visible) return null;
    this.inverse.copy(this.object.matrix).invert();
    const from = origin.clone().applyMatrix4(this.inverse),
      along = direction.clone().transformDirection(this.inverse);
    if (along.z > -1e-6 || from.z <= 0) return null;
    const distance = -from.z / along.z;
    const x = from.x + along.x * distance,
      y = from.y + along.y * distance;
    const size = this.object.geometry.parameters;
    if (Math.abs(x) > size.width / 2 || Math.abs(y) > size.height / 2) return null;
    const px = (x / size.width + 0.5) * width,
      py = (0.5 - y / size.height) * height;
    const button = this.buttons.find(
      (b) => px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height,
    );
    const point = new Vector3(x, y, 0).applyMatrix4(this.object.matrix);
    return {
      distance: point.distanceTo(origin),
      point,
      // A disabled control consumes the press; only blank background can drag the panel.
      action: button ? (button.enabled ? button.action : 'noop') : null,
    };
  }

  center(action: PanelAction) {
    const button = this.buttons.find((b) => b.action === action);
    if (!button) return null;
    const size = this.object.geometry.parameters;
    return new Vector3(
      ((button.x + button.width / 2) / width - 0.5) * size.width,
      (0.5 - (button.y + button.height / 2) / height) * size.height,
      0,
    ).applyMatrix4(this.object.matrix);
  }

  dispose() {
    this.texture.dispose();
    this.object.geometry.dispose();
    this.object.material.dispose();
  }

  private grid(button: Omit<Button, 'x' | 'y' | 'width' | 'height'>, index: number) {
    this.buttons.push({
      ...button,
      x: margin + (index % 2) * (half + 16),
      y: 234 + Math.floor(index / 2) * 76,
      width: half,
      height: 64,
    });
  }

  private row(buttons: Omit<Button, 'x' | 'y' | 'width' | 'height'>[], y: number, height = 64) {
    const gap = 12;
    const column = (inner - gap * (buttons.length - 1)) / buttons.length;
    buttons.forEach((button, index) =>
      this.buttons.push({
        ...button,
        x: margin + index * (column + gap),
        y,
        width: column,
        height,
      }),
    );
  }

  private adjustments(state: PanelState) {
    const third = (inner - 24) / 3;
    [
      { action: 'precision' as const, label: 'Precision', on: state.precision },
      { action: 'multiSelect' as const, label: 'Multi-select', on: state.multiSelect },
      { action: 'axis' as const, label: `Axis ${state.axis.toUpperCase()}` },
    ].forEach((button, i) =>
      this.buttons.push({
        ...button,
        x: margin + i * (third + 12),
        y: 550,
        width: third,
        height: 56,
        enabled: true,
      }),
    );
  }

  private draw(state: PanelState) {
    const c = this.context;
    c.clearRect(0, 0, width, height);
    c.fillStyle = colors.panel;
    c.strokeStyle = colors.border;
    c.lineWidth = 3;
    c.beginPath();
    c.roundRect(1.5, 1.5, width - 3, height - 3, 30);
    c.fill();
    c.stroke();
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    c.fillStyle = colors.text;
    c.font = `700 38px ${font}`;
    c.fillText('kitbasher', margin, 82);
    c.fillStyle = colors.accent;
    c.fillText('.', margin + c.measureText('kitbasher').width, 82);
    c.font = `600 24px ${font}`;
    c.textAlign = 'right';
    c.fillText(
      xrToolChoices.find((choice) => choice.tool === state.tool)?.label ?? state.tool,
      width - margin,
      82,
    );
    c.textAlign = 'left';
    c.fillStyle = colors.muted;
    c.font = `400 24px ${font}`;
    c.fillText(this.fit(state.name, inner), margin, 120);

    const tabWidth = (inner - 36) / 4;
    this.buttons = (['tools', 'tool', 'view', 'bindings'] as const).map((page, i) => ({
      action: `page:${page}`,
      label: { tools: 'Tools', tool: 'Active tool', view: 'View', bindings: 'Bindings' }[page],
      selected: this.page === page || (page === 'view' && this.page === 'world'),
      x: margin + i * (tabWidth + 12),
      y: 150,
      width: tabWidth,
      height: 58,
      enabled: true,
    }));
    if (this.page === 'tools') {
      xrToolChoices.forEach(({ tool, label }, index) =>
        this.grid(
          { action: `tool:${tool}`, label, enabled: true, selected: state.tool === tool },
          index,
        ),
      );
      this.adjustments(state);
    } else if (this.page === 'tool') {
      state.toolButtons
        .slice(0, 8)
        .forEach((button, index) =>
          this.grid({ ...button, action: `edit:${button.action}` }, index),
        );
      this.adjustments(state);
    } else if (this.page === 'bindings') {
      xrButtons.forEach((button, index) =>
        this.grid(
          {
            action: `bind:button:${button}`,
            label: xrButtonLabels[button],
            detail: xrButtonActions.find(({ id }) => id === state.inputSettings.buttons[button])!
              .label,
            enabled: true,
          },
          index,
        ),
      );
      (['left', 'right'] as const).forEach((hand, i) =>
        this.grid(
          {
            action: `bind:axis:${hand}`,
            label: `${hand === 'left' ? 'Left' : 'Right'} thumbstick`,
            detail: xrAxisActions.find(({ id }) => id === state.inputSettings.axes[hand])!.label,
            enabled: true,
          },
          6 + i,
        ),
      );
      this.grid(
        {
          action: 'bind:dominantHand',
          label: `Main hand: ${state.inputSettings.dominantHand}`,
          enabled: true,
        },
        8,
      );
      this.grid({ action: 'bind:reset', label: 'Reset bindings', enabled: true }, 9);
    } else if (this.page === 'world') {
      c.fillStyle = colors.text;
      c.font = `700 28px ${font}`;
      c.fillText('World controls', margin, 264);
      this.row(
        [
          {
            action: 'bind:zoomSpeed',
            label: 'Zoom speed',
            detail: `${state.inputSettings.zoomSpeed}×`,
            enabled: true,
          },
          {
            action: 'bind:turnAngle',
            label: 'Turn increment',
            detail: `${state.inputSettings.turnAngle}°`,
            enabled: true,
          },
        ],
        286,
        76,
      );
      this.row(
        [
          {
            action: 'bind:triggerWorld',
            label: `Trigger pulls world: ${state.inputSettings.triggerWorld ? 'On' : 'Off'}`,
            detail: state.inputSettings.triggerWorld
              ? 'Trigger on empty space or locked parts moves the world'
              : 'Trigger selects parts; use grip to move the world',
            enabled: true,
            on: state.inputSettings.triggerWorld,
          },
        ],
        378,
        76,
      );
      c.fillStyle = colors.muted;
      c.font = `400 23px ${font}`;
      c.fillText('Grip always moves the world.', margin, 493);
      c.fillText('Bare-hand pinch on empty space still moves it.', margin, 526);
      this.row([{ action: 'page:view', label: 'Back to view', enabled: true }], 550, 56);
    } else {
      // Keep world navigation separate from the active tool's transform controls.
      c.fillStyle = colors.muted;
      c.font = `600 19px ${font}`;
      c.fillText('WORLD SCALE', margin, 253);
      c.fillStyle = colors.text;
      c.font = `700 52px ${font}`;
      c.fillText(state.scale, margin - 3, 301);
      const zoomWidth = 238;
      this.buttons.push(
        {
          action: 'zoomOut',
          x: 308,
          y: 234,
          width: zoomWidth,
          height: 70,
          label: 'Zoom −',
          enabled: state.canZoomOut,
        },
        {
          action: 'zoomIn',
          x: 562,
          y: 234,
          width: zoomWidth,
          height: 70,
          label: 'Zoom +',
          enabled: state.canZoomIn,
        },
      );
      this.row(
        [
          {
            action: 'turnLeft',
            label: `Turn left ${state.inputSettings.turnAngle}°`,
            enabled: true,
          },
          {
            action: 'turnRight',
            label: `Turn right ${state.inputSettings.turnAngle}°`,
            enabled: true,
          },
          { action: 'previousView', label: 'Previous view', enabled: state.canRestoreView },
        ],
        320,
      );
      this.row(
        [
          { action: 'reset', label: 'Frame visible', enabled: true },
          { action: 'focusSelection', label: 'Focus selection', enabled: state.canFocusSelection },
          { action: 'trueSize', label: '1:1', enabled: true },
        ],
        396,
      );
      this.row(
        [
          { action: 'undo', label: 'Undo', enabled: state.canUndo },
          { action: 'redo', label: 'Redo', enabled: state.canRedo },
          { action: 'clip', label: 'No clip', enabled: true, on: state.clip },
          { action: 'level', label: 'Keep level', enabled: true, on: state.level },
        ],
        472,
      );
      this.row([{ action: 'page:world', label: 'World settings', enabled: true }], 550, 56);
    }
    this.buttons.push({
      action: 'exit',
      x: margin,
      y: 760,
      width: inner,
      height: 84,
      label: 'Leave headset view',
      enabled: true,
    });
    for (const button of this.buttons) this.drawButton(button);
    c.textAlign = 'left';
    c.fillStyle = colors.muted;
    c.font = `400 22px ${font}`;
    const hints =
      this.page === 'bindings'
        ? [
            'Press a binding to cycle its action. Changes are saved.',
            'Main hand moves the wrist palette to the opposite hand.',
          ]
        : this.page === 'world'
          ? [
              'Hold grip + stick: up/down zoom · left/right turn',
              'Release the stick before another turn.',
              'Changes are saved in this browser.',
            ]
          : state.hints;
    const hintCount = ['view', 'tool', 'world'].includes(this.page) ? 3 : 2;
    hints
      .slice(0, hintCount)
      .forEach((hint, i) => c.fillText(this.fit(hint, inner), margin, 628 + i * 23));
    c.fillStyle = colors.accent;
    c.font = `600 23px ${font}`;
    c.fillText(this.fit(state.toolStatus, inner), margin, 699);
    c.fillStyle = colors.text;
    c.font = `400 21px ${font}`;
    c.fillText(this.fit(state.status, inner), margin, 724);
    c.fillStyle = colors.muted;
    c.font = `400 18px ${font}`;
    c.fillText(this.fit(state.stats, inner), margin, 746);
  }

  private drawButton(button: Button) {
    const c = this.context;
    const pressed = button.enabled && this.pressed === button.action,
      hovered = button.enabled && this.hovered === button.action;
    c.fillStyle = pressed ? colors.accent : hovered ? colors.hover : colors.raised;
    c.strokeStyle =
      hovered || pressed || button.selected || button.on ? colors.accent : colors.border;
    c.lineWidth = button.selected ? 3 : 2;
    c.beginPath();
    c.roundRect(button.x, button.y, button.width, button.height, 12);
    c.fill();
    c.stroke();
    c.fillStyle = !button.enabled ? colors.faint : pressed ? colors.ink : colors.text;
    const size = button.width < 260 ? 23 : 26;
    c.font = `600 ${size}px ${font}`;
    c.textAlign = 'center';
    const limit = button.width - 28;
    if (button.detail) {
      c.fillText(this.fit(button.label, limit), button.x + button.width / 2, button.y + 27);
      c.fillStyle = pressed ? colors.ink : colors.muted;
      c.font = `400 21px ${font}`;
      c.fillText(this.fit(button.detail, limit), button.x + button.width / 2, button.y + 51);
    } else {
      const label =
        button.on === undefined ? button.label : `${button.on ? '●' : '○'} ${button.label}`;
      c.fillText(
        this.fit(label, limit),
        button.x + button.width / 2,
        button.y + button.height / 2 + size * 0.34,
      );
    }
  }

  private fit(text: string, limit: number) {
    const c = this.context;
    if (c.measureText(text).width <= limit) return text;
    let end = text.length;
    while (end > 1 && c.measureText(`${text.slice(0, end)}…`).width > limit) end--;
    return `${text.slice(0, end)}…`;
  }
}
