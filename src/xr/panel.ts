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
import { facing } from '../core/xr';

export type PanelAction = 'undo' | 'redo' | 'trueSize' | 'reset' | 'clip' | 'level' | 'exit';

export interface PanelState {
  name: string;
  scale: string;
  canUndo: boolean;
  canRedo: boolean;
  clip: boolean;
  level: boolean;
  status: string;
  stats: string;
}

interface Button {
  action: PanelAction;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  enabled: boolean;
  /** Set on a switch, which shows whether it is on. */
  on?: boolean;
}

export interface PanelHit {
  /** Meters along the ray. */
  distance: number;
  /** In the room. */
  point: Vector3;
  action: PanelAction | null;
}

// Canvas pixels. Three to the millimeter keeps text sharp at arm's length.
const width = 840;
const height = 884;
const density = 3000;
const margin = 40;
const inner = width - margin * 2;
const half = (inner - 16) / 2;
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

const hints = [
  'Trigger on a part: move it',
  'Trigger on empty space, or grip: move the world',
  'Both hands: resize and turn the world',
];

/**
 * The in-headset controls: a flat panel drawn with a 2D canvas, since the page's own interface
 * is not shown while a headset session runs. It hangs in the room, not in the scene.
 */
export class Panel {
  readonly object: Mesh<PlaneGeometry, MeshBasicMaterial>;
  hovered: PanelAction | null = null;
  pressed: PanelAction | null = null;
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
        // Always in view and within reach, even when a magnified part surrounds it.
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.object.renderOrder = 10;
    // The interface font may still be loading the first time this draws.
    void document.fonts?.ready.then(() => {
      this.drawn = '';
    });
  }

  /** Hangs the panel within reach, to the lower left of where the viewer is looking. */
  place(head: Matrix4) {
    const { position, forward } = facing(head);
    const left = new Vector3(0, 1, 0).cross(forward);
    this.object.position
      .copy(position)
      .addScaledVector(forward, 0.5)
      .addScaledVector(left, 0.34)
      .add(new Vector3(0, -0.2, 0));
    // The panel is placed in the room, so it cannot use lookAt, which aims in the scene.
    this.object.quaternion.setFromRotationMatrix(
      this.inverse.lookAt(position, this.object.position, this.object.up),
    );
    this.object.updateMatrix();
  }

  update(state: PanelState) {
    const key = JSON.stringify([state, this.hovered, this.pressed]);
    if (key === this.drawn) return;
    this.drawn = key;
    this.draw(state);
    this.texture.needsUpdate = true;
  }

  /** Where a ray in the room meets the front of the panel. */
  hit(origin: Vector3, direction: Vector3): PanelHit | null {
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
      (b) => b.enabled && px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height,
    );
    return {
      distance,
      point: new Vector3(x, y, 0).applyMatrix4(this.object.matrix),
      action: button?.action ?? null,
    };
  }

  /** The middle of a control, in the room. */
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
    c.fillStyle = colors.muted;
    c.font = `400 24px ${font}`;
    c.fillText(this.fit(state.name, inner), margin, 120);
    c.fillStyle = colors.border;
    c.fillRect(margin, 142, inner, 2);

    c.fillStyle = colors.muted;
    c.font = `600 19px ${font}`;
    c.fillText('WORLD SCALE', margin, 192);
    c.fillStyle = colors.text;
    c.font = `700 70px ${font}`;
    c.fillText(state.scale, margin - 3, 270);

    this.buttons = [
      { action: 'trueSize', x: 430, y: 206, width: 150, height: 72, label: '1:1', enabled: true },
      {
        action: 'reset',
        x: 596,
        y: 206,
        width: 204,
        height: 72,
        label: 'Reset view',
        enabled: true,
      },
      {
        action: 'undo',
        x: margin,
        y: 322,
        width: half,
        height: 84,
        label: 'Undo',
        enabled: state.canUndo,
      },
      {
        action: 'redo',
        x: margin + half + 16,
        y: 322,
        width: half,
        height: 84,
        label: 'Redo',
        enabled: state.canRedo,
      },
      {
        action: 'clip',
        x: margin,
        y: 422,
        width: half,
        height: 84,
        label: 'No clip',
        enabled: true,
        on: state.clip,
      },
      {
        action: 'level',
        x: margin + half + 16,
        y: 422,
        width: half,
        height: 84,
        label: 'Keep level',
        enabled: true,
        on: state.level,
      },
      {
        action: 'exit',
        x: margin,
        y: 760,
        width: inner,
        height: 84,
        label: 'Leave headset view',
        enabled: true,
      },
    ];
    for (const button of this.buttons) this.drawButton(button);

    c.textAlign = 'left';
    c.fillStyle = colors.muted;
    c.font = `400 23px ${font}`;
    hints.forEach((hint, i) => c.fillText(hint, margin, 556 + i * 34));
    c.fillStyle = colors.text;
    c.font = `500 25px ${font}`;
    c.fillText(this.fit(state.status, inner), margin, 682);
    c.fillStyle = colors.muted;
    c.font = `400 21px ${font}`;
    c.fillText(this.fit(state.stats, inner), margin, 722);
  }

  private drawButton(button: Button) {
    const c = this.context;
    const pressed = button.enabled && this.pressed === button.action,
      hovered = button.enabled && this.hovered === button.action;
    c.fillStyle = pressed ? colors.accent : hovered ? colors.hover : colors.raised;
    c.strokeStyle = hovered || pressed ? colors.accent : colors.border;
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(button.x, button.y, button.width, button.height, 14);
    c.fill();
    c.stroke();
    c.fillStyle = !button.enabled ? colors.faint : pressed ? colors.ink : colors.text;
    c.font = `600 29px ${font}`;
    const baseline = button.y + button.height / 2 + 10;
    if (button.on === undefined) {
      c.textAlign = 'center';
      c.fillText(button.label, button.x + button.width / 2, baseline);
      return;
    }
    c.textAlign = 'left';
    c.fillText(button.label, button.x + 24, baseline);
    const track = { width: 64, height: 34 };
    const x = button.x + button.width - track.width - 22,
      y = button.y + (button.height - track.height) / 2;
    c.fillStyle = button.on ? colors.accent : colors.faint;
    c.beginPath();
    c.roundRect(x, y, track.width, track.height, track.height / 2);
    c.fill();
    c.fillStyle = button.on ? colors.ink : colors.text;
    c.beginPath();
    c.arc(
      button.on ? x + track.width - track.height / 2 : x + track.height / 2,
      y + track.height / 2,
      track.height / 2 - 5,
      0,
      Math.PI * 2,
    );
    c.fill();
  }

  /** Shortens text that would run past the edge of the panel. */
  private fit(text: string, limit: number) {
    const c = this.context;
    if (c.measureText(text).width <= limit) return text;
    let end = text.length;
    while (end > 1 && c.measureText(`${text.slice(0, end)}…`).width > limit) end--;
    return `${text.slice(0, end)}…`;
  }
}
