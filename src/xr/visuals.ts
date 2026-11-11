import {
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
} from 'three';

export type Tone = 'idle' | 'hover' | 'hold' | 'world';

const tones: Record<Tone, { color: string; beam: number }> = {
  idle: { color: '#e9eaec', beam: 0.28 },
  hover: { color: '#ed9b54', beam: 0.75 },
  hold: { color: '#ffb876', beam: 0.9 },
  world: { color: '#8fb8ff', beam: 0.75 },
};

const forward = new Vector3(0, 0, -1);
const maxJoints = 25;

const flat = (opacity = 1, overlay = false) =>
  new MeshBasicMaterial({
    transparent: true,
    opacity,
    toneMapped: false,
    depthTest: !overlay,
    depthWrite: false,
  });

/**
 * What shows where one controller or hand is and what it points at. Everything here is placed
 * in the room, in meters, so it keeps its size however large the scene looks.
 */
export class PointerVisual {
  readonly object = new Group();
  private readonly tip: Mesh<SphereGeometry, MeshBasicMaterial>;
  private readonly cursor: Mesh<SphereGeometry, MeshBasicMaterial>;
  private readonly beam: Mesh<CylinderGeometry, MeshBasicMaterial>;
  private readonly joints: InstancedMesh<SphereGeometry, MeshBasicMaterial>;
  private readonly scratch = new Matrix4();
  private readonly color = new Color();

  constructor() {
    const sphere = new SphereGeometry(1, 16, 12);
    // A unit beam from the origin along -Z, stretched to reach what it points at.
    const tube = new CylinderGeometry(1, 1, 1, 8, 1, true)
      .rotateX(-Math.PI / 2)
      .translate(0, 0, -0.5);
    this.tip = new Mesh(sphere, flat(0.95, true));
    this.cursor = new Mesh(sphere, flat(0.95, true));
    this.beam = new Mesh(tube, flat());
    this.joints = new InstancedMesh(sphere, flat(0.55), maxJoints);
    this.tip.scale.setScalar(0.004);
    this.cursor.scale.setScalar(0.003);
    this.tip.renderOrder = this.cursor.renderOrder = 20;
    this.joints.count = 0;
    // Its bounds are those of one sphere at the origin, wherever the joints are.
    this.joints.frustumCulled = false;
    this.object.add(this.tip, this.cursor, this.beam, this.joints);
  }

  /** Marks the hand, and with an end point draws a beam to it, optionally ending in a dot. */
  show(hand: Vector3, tone: Tone, beam?: { from: Vector3; to: Vector3; dot: boolean }) {
    const { color, beam: opacity } = tones[tone];
    this.color.set(color);
    this.object.visible = true;
    this.tip.position.copy(hand);
    this.tip.material.color.copy(this.color);
    this.beam.visible = this.cursor.visible = false;
    if (!beam) return;
    const span = beam.to.clone().sub(beam.from);
    const length = span.length();
    if (length > 1e-4) {
      this.beam.visible = true;
      this.beam.position.copy(beam.from);
      this.beam.quaternion.setFromUnitVectors(forward, span.divideScalar(length));
      this.beam.scale.set(0.0011, 0.0011, length);
      this.beam.material.color.copy(this.color);
      this.beam.material.opacity = opacity;
    }
    if (beam.dot) {
      this.cursor.visible = true;
      this.cursor.position.copy(beam.to);
      this.cursor.material.color.copy(this.color);
    }
  }

  /** Draws a tracked hand as its joints, given as positions and radii in the room. */
  showJoints(joints: { position: Vector3; radius: number }[]) {
    this.joints.count = Math.min(joints.length, maxJoints);
    for (let i = 0; i < this.joints.count; i++) {
      const { position, radius } = joints[i];
      const size = radius * 0.8;
      this.scratch.makeScale(size, size, size).setPosition(position);
      this.joints.setMatrixAt(i, this.scratch);
    }
    this.joints.instanceMatrix.needsUpdate = true;
  }

  hide() {
    this.object.visible = false;
  }

  dispose() {
    this.tip.geometry.dispose();
    this.beam.geometry.dispose();
    for (const mesh of [this.tip, this.cursor, this.beam, this.joints]) mesh.material.dispose();
    this.joints.dispose();
  }
}

/** A tint over one part, drawn in the scene exactly where the part is. */
export class Highlight {
  readonly object = new Mesh<BufferGeometry, MeshBasicMaterial>(
    undefined,
    new MeshBasicMaterial({
      color: tones.hover.color,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      toneMapped: false,
      // Drawn on the part's own surface, so it must win the tie in depth.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );

  constructor() {
    this.object.matrixAutoUpdate = false;
    this.object.visible = false;
    this.object.raycast = () => {};
  }

  show(part: Mesh) {
    this.object.geometry = part.geometry;
    this.object.matrix.copy(part.matrixWorld);
    this.object.matrixWorldNeedsUpdate = true;
    this.object.visible = true;
  }

  hide() {
    this.object.visible = false;
  }

  /** The geometry is the part's own, and is not this one's to free. */
  dispose() {
    this.object.material.dispose();
  }
}

/** A small sign in the room that always faces the viewer, such as the scale between two hands. */
export class Readout {
  readonly object: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private readonly turn = new Matrix4();
  private text = '';

  constructor() {
    this.canvas.width = 320;
    this.canvas.height = 128;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    const material = flat(1, true);
    material.map = this.texture;
    this.object = new Mesh(new PlaneGeometry(0.1, 0.04), material);
    this.object.renderOrder = 30;
    this.object.visible = false;
  }

  show(text: string, position: Vector3, head: Vector3) {
    this.object.visible = true;
    this.object.position.copy(position);
    this.object.quaternion.setFromRotationMatrix(this.turn.lookAt(head, position, this.object.up));
    if (text === this.text) return;
    this.text = text;
    const c = this.canvas.getContext('2d')!;
    c.clearRect(0, 0, 320, 128);
    c.fillStyle = '#202226f0';
    c.beginPath();
    c.roundRect(4, 4, 312, 120, 28);
    c.fill();
    c.fillStyle = '#e9eaec';
    c.font = '700 72px "Inter Variable", Inter, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, 160, 68);
    this.texture.needsUpdate = true;
  }

  hide() {
    this.object.visible = false;
  }

  dispose() {
    this.texture.dispose();
    this.object.geometry.dispose();
    this.object.material.dispose();
  }
}
