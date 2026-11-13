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
import { xrToolChoices } from './editor-tools';
import type { PanelAction, PanelHit } from './panel';

const width = 660,
  height = 600,
  density = 3000;
const margin = 24,
  gap = 16,
  buttonWidth = (width - margin * 2 - gap) / 2;
const font = '"Inter Variable", Inter, system-ui, sans-serif';

/** A compact palette above the off hand, readable from the viewer's current position. */
export class WristPalette {
  readonly object: Mesh<PlaneGeometry, MeshBasicMaterial>;
  hovered: PanelAction | null = null;
  pressed: PanelAction | null = null;
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly inverse = new Matrix4();
  private drawn = '';
  private readonly buttons = xrToolChoices.map(({ tool, label }, index) => ({
    tool,
    label,
    x: margin + (index % 2) * (buttonWidth + gap),
    y: 80 + Math.floor(index / 2) * 116,
    width: buttonWidth,
    height: 104,
  }));

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
    this.object.renderOrder = 11;
    this.object.visible = false;
    void document.fonts?.ready.then(() => {
      this.drawn = '';
    });
  }

  place(hand: Matrix4, head: Matrix4) {
    this.object.position.setFromMatrixPosition(hand).add(new Vector3(0, 0.11, 0));
    const eye = new Vector3().setFromMatrixPosition(head);
    this.object.quaternion.setFromRotationMatrix(
      this.inverse.lookAt(eye, this.object.position, this.object.up),
    );
    this.object.updateMatrix();
  }

  update(tool: Tool) {
    const key = JSON.stringify([tool, this.hovered, this.pressed]);
    if (key === this.drawn) return;
    this.drawn = key;
    const c = this.context;
    c.clearRect(0, 0, width, height);
    c.fillStyle = '#202226';
    c.strokeStyle = '#5d626b';
    c.lineWidth = 3;
    c.beginPath();
    c.roundRect(2, 2, width - 4, height - 4, 28);
    c.fill();
    c.stroke();
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#ed9b54';
    c.font = `700 29px ${font}`;
    c.fillText('TOOLS', margin, 53);
    c.textAlign = 'right';
    c.fillStyle = '#959aa3';
    c.font = `400 24px ${font}`;
    c.fillText('Trigger to choose', width - margin, 53);
    for (const button of this.buttons) {
      const action = `tool:${button.tool}`;
      const pressed = this.pressed === action,
        hovered = this.hovered === action,
        active = tool === button.tool;
      c.fillStyle = pressed ? '#ed9b54' : hovered ? '#3b4048' : '#2c2f35';
      c.strokeStyle = active || pressed || hovered ? '#ed9b54' : '#3a3e45';
      c.lineWidth = active ? 4 : 2;
      c.beginPath();
      c.roundRect(button.x, button.y, button.width, button.height, 14);
      c.fill();
      c.stroke();
      c.fillStyle = pressed ? '#1b1d20' : active ? '#ed9b54' : '#e9eaec';
      c.textAlign = 'center';
      c.font = `600 32px ${font}`;
      c.fillText(
        button.label,
        button.x + button.width / 2,
        button.y + button.height / 2 + 11,
        button.width - 28,
      );
    }
    c.fillStyle = '#959aa3';
    c.font = `400 25px ${font}`;
    c.textAlign = 'center';
    c.fillText('Point with your other hand', width / 2, 574);
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
      action: button ? `tool:${button.tool}` : null,
    };
  }

  center(tool: Tool) {
    const button = this.buttons.find((button) => button.tool === tool);
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
}
